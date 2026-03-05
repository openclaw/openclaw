import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  registerWebhookTargetWithPluginRoute,
  readWebhookBodyOrReject,
  resolveWebhookTargetWithAuthOrRejectSync,
  resolveWebhookTargets,
} from "openclaw/plugin-sdk/bluebubbles";
import { createBlueBubblesDebounceRegistry } from "./monitor-debounce.js";
import {
  hasReactionMarkers,
  normalizeWebhookMessage,
  normalizeWebhookReaction,
} from "./monitor-normalize.js";
import { logVerbose, processMessage, processReaction } from "./monitor-processing.js";
import {
  _resetBlueBubblesShortIdState,
  resolveBlueBubblesMessageId,
} from "./monitor-reply-cache.js";
import {
  DEFAULT_WEBHOOK_PATH,
  normalizeWebhookPath,
  resolveWebhookPathFromConfig,
  type BlueBubblesMonitorOptions,
  type WebhookTarget,
} from "./monitor-shared.js";
import { fetchBlueBubblesServerInfo } from "./probe.js";
import { getBlueBubblesRuntime } from "./runtime.js";

const webhookTargets = new Map<string, WebhookTarget[]>();
const webhookInFlightLimiter = createWebhookInFlightLimiter();
const debounceRegistry = createBlueBubblesDebounceRegistry({ processMessage });

export function registerBlueBubblesWebhookTarget(target: WebhookTarget): () => void {
  const registered = registerWebhookTargetWithPluginRoute({
    targetsByPath: webhookTargets,
    target,
    route: {
      auth: "plugin",
      match: "exact",
      pluginId: "bluebubbles",
      source: "bluebubbles-webhook",
      accountId: target.account.accountId,
      log: target.runtime.log,
      handler: async (req, res) => {
        const handled = await handleBlueBubblesWebhookRequest(req, res);
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
        }
      },
    },
  });
  return () => {
    registered.unregister();
    // Clean up debouncer when target is unregistered
    debounceRegistry.removeDebouncer(registered.target);
  };
}

function parseBlueBubblesWebhookPayload(
  rawBody: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return { ok: false, error: "empty payload" };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    const params = new URLSearchParams(rawBody);
    const payload = params.get("payload") ?? params.get("data") ?? params.get("message");
    if (!payload) {
      return { ok: false, error: "invalid json" };
    }
    try {
      return { ok: true, value: JSON.parse(payload) as unknown };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function maskSecret(value: string): string {
  if (value.length <= 6) {
    return "***";
  }
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function normalizeAuthToken(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return "";
  }
  if (value.toLowerCase().startsWith("bearer ")) {
    return value.slice("bearer ".length).trim();
  }
  return value;
}

function safeEqualSecret(aRaw: string, bRaw: string): boolean {
  const a = normalizeAuthToken(aRaw);
  const b = normalizeAuthToken(bRaw);
  if (!a || !b) {
    return false;
  }
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export async function handleBlueBubblesWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const resolved = resolveWebhookTargets(req, webhookTargets);
  if (!resolved) {
    return false;
  }
  const { path, targets } = resolved;
  const url = new URL(req.url ?? "/", "http://localhost");
  const requestLifecycle = beginWebhookRequestPipelineOrReject({
    req,
    res,
    allowMethods: ["POST"],
    inFlightLimiter: webhookInFlightLimiter,
    inFlightKey: `${path}:${req.socket.remoteAddress ?? "unknown"}`,
  });
  if (!requestLifecycle.ok) {
    return true;
  }

  try {
    const guidParam = url.searchParams.get("guid") ?? url.searchParams.get("password");
    const headerToken =
      req.headers["x-guid"] ??
      req.headers["x-password"] ??
      req.headers["x-bluebubbles-guid"] ??
      req.headers["authorization"];
    const guid = (Array.isArray(headerToken) ? headerToken[0] : headerToken) ?? guidParam ?? "";
    const target = resolveWebhookTargetWithAuthOrRejectSync({
      targets,
      res,
      isMatch: (target) => {
        const token = target.account.config.password?.trim() ?? "";
        return safeEqualSecret(guid, token);
      },
    });
    if (!target) {
      console.warn(
        `[bluebubbles] webhook rejected: status=${res.statusCode} path=${path} guid=${maskSecret(url.searchParams.get("guid") ?? url.searchParams.get("password") ?? "")}`,
      );
      return true;
    }
    const body = await readWebhookBodyOrReject({
      req,
      res,
      profile: "post-auth",
      invalidBodyMessage: "invalid payload",
    });
    if (!body.ok) {
      console.warn(`[bluebubbles] webhook rejected: status=${res.statusCode}`);
      return true;
    }

    const parsed = parseBlueBubblesWebhookPayload(body.value);
    if (!parsed.ok) {
      res.statusCode = 400;
      res.end(parsed.error);
      console.warn(`[bluebubbles] webhook rejected: ${parsed.error}`);
      return true;
    }

    const payload = asRecord(parsed.value) ?? {};
    const firstTarget = targets[0];
    if (firstTarget) {
      logVerbose(
        firstTarget.core,
        firstTarget.runtime,
        `webhook received path=${path} keys=${Object.keys(payload).join(",") || "none"}`,
      );
    }
    const eventTypeRaw = payload.type;
    const eventType = typeof eventTypeRaw === "string" ? eventTypeRaw.trim() : "";
    const allowedEventTypes = new Set([
      "new-message",
      "updated-message",
      "message-reaction",
      "reaction",
    ]);
    if (eventType && !allowedEventTypes.has(eventType)) {
      res.statusCode = 200;
      res.end("ok");
      if (firstTarget) {
        logVerbose(firstTarget.core, firstTarget.runtime, `webhook ignored type=${eventType}`);
      }
      return true;
    }
    const reaction = normalizeWebhookReaction(payload);
    if (
      (eventType === "updated-message" ||
        eventType === "message-reaction" ||
        eventType === "reaction") &&
      !reaction
    ) {
      res.statusCode = 200;
      res.end("ok");
      if (firstTarget) {
        logVerbose(
          firstTarget.core,
          firstTarget.runtime,
          `webhook ignored ${eventType || "event"} without reaction`,
        );
      }
      return true;
    }
    const message = reaction ? null : normalizeWebhookMessage(payload);
    if (!message && !reaction) {
      // Tolerate unprocessable reactions (e.g. missing sender handle in group chats)
      // instead of returning 400, which causes BlueBubbles webhook retries and log spam.
      if (hasReactionMarkers(payload)) {
        res.statusCode = 200;
        res.end("ok");
        if (firstTarget) {
          logVerbose(
            firstTarget.core,
            firstTarget.runtime,
            `webhook ignored unprocessable reaction (missing sender context)`,
          );
        }
        return true;
      }
      res.statusCode = 400;
      res.end("invalid payload");
      console.warn("[bluebubbles] webhook rejected: unable to parse message payload");
      return true;
    }

    target.statusSink?.({ lastInboundAt: Date.now() });
    if (reaction) {
      processReaction(reaction, target).catch((err) => {
        target.runtime.error?.(
          `[${target.account.accountId}] BlueBubbles reaction failed: ${String(err)}`,
        );
      });
    } else if (message) {
      // Route messages through debouncer to coalesce rapid-fire events
      // (e.g., text message + URL balloon arriving as separate webhooks)
      const debouncer = debounceRegistry.getOrCreateDebouncer(target);
      debouncer.enqueue({ message, target }).catch((err) => {
        target.runtime.error?.(
          `[${target.account.accountId}] BlueBubbles webhook failed: ${String(err)}`,
        );
      });
    }

    res.statusCode = 200;
    res.end("ok");
    if (reaction) {
      if (firstTarget) {
        logVerbose(
          firstTarget.core,
          firstTarget.runtime,
          `webhook accepted reaction sender=${reaction.senderId} msg=${reaction.messageId} action=${reaction.action}`,
        );
      }
    } else if (message) {
      if (firstTarget) {
        logVerbose(
          firstTarget.core,
          firstTarget.runtime,
          `webhook accepted sender=${message.senderId} group=${message.isGroup} chatGuid=${message.chatGuid ?? ""} chatId=${message.chatId ?? ""}`,
        );
      }
    }
    return true;
  } finally {
    requestLifecycle.release();
  }
}

export async function monitorBlueBubblesProvider(
  options: BlueBubblesMonitorOptions,
): Promise<void> {
  const { account, config, runtime, abortSignal, statusSink } = options;
  const core = getBlueBubblesRuntime();
  const path = options.webhookPath?.trim() || DEFAULT_WEBHOOK_PATH;

  // Fetch and cache server info (for macOS version detection in action gating)
  const serverInfo = await fetchBlueBubblesServerInfo({
    baseUrl: account.baseUrl,
    password: account.config.password,
    accountId: account.accountId,
    timeoutMs: 5000,
  }).catch(() => null);
  if (serverInfo?.os_version) {
    runtime.log?.(`[${account.accountId}] BlueBubbles server macOS ${serverInfo.os_version}`);
  }
  if (typeof serverInfo?.private_api === "boolean") {
    runtime.log?.(
      `[${account.accountId}] BlueBubbles Private API ${serverInfo.private_api ? "enabled" : "disabled"}`,
    );
  }

  const unregister = registerBlueBubblesWebhookTarget({
    account,
    config,
    runtime,
    core,
    path,
    statusSink,
  });

  return await new Promise((resolve) => {
    const stop = () => {
      unregister();
      resolve();
    };

    if (abortSignal?.aborted) {
      stop();
      return;
    }

    abortSignal?.addEventListener("abort", stop, { once: true });
    runtime.log?.(
      `[${account.accountId}] BlueBubbles webhook listening on ${normalizeWebhookPath(path)}`,
    );
  });
}

export { _resetBlueBubblesShortIdState, resolveBlueBubblesMessageId, resolveWebhookPathFromConfig };
