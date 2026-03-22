import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  beginWebhookRequestPipelineOrReject,
  createDedupeCache,
  resolveWebhookTargets,
} from "openclaw/plugin-sdk/bluebubbles";
import { createBlueBubblesDebounceRegistry } from "./monitor-debounce.js";
import {
  normalizeWebhookMessage,
  normalizeWebhookReaction,
  type NormalizedWebhookMessage,
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
import {
  createWebhookInFlightLimiter,
  registerWebhookTargetWithPluginRoute,
  readWebhookBodyOrReject,
  resolveWebhookTargetWithAuthOrRejectSync,
  withResolvedWebhookRequestPipeline,
} from "./runtime-api.js";
import { getBlueBubblesRuntime } from "./runtime.js";
import type { BlueBubblesAttachment } from "./types.js";

const webhookTargets = new Map<string, WebhookTarget[]>();
const webhookInFlightLimiter = createWebhookInFlightLimiter();
const debounceRegistry = createBlueBubblesDebounceRegistry({ processMessage });
const BLUEBUBBLES_WEBHOOK_REPLAY_WINDOW_MS = 5 * 60_000;
const BLUEBUBBLES_WEBHOOK_REPLAY_CACHE_MAX_SIZE = 10_000;
const recentInboundWebhookEvents = createDedupeCache({
  ttlMs: BLUEBUBBLES_WEBHOOK_REPLAY_WINDOW_MS,
  maxSize: BLUEBUBBLES_WEBHOOK_REPLAY_CACHE_MAX_SIZE,
});
const pendingInboundWebhookReplayKeys = new Set<string>();
type PendingWebhookReplayRetryEntry = {
  message: NormalizedWebhookMessage;
  target: WebhookTarget;
  eventType: string;
};
const pendingInboundWebhookReplayRetries = new Map<string, PendingWebhookReplayRetryEntry>();

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

function looksLikeBlueBubblesGuid(value: string): boolean {
  // Restrict to canonical UUID form to avoid dropping human-edited slugs/ticket IDs.
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    value,
  );
}

function computeReplayTextFingerprint(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  return createHash("sha1").update(trimmed).digest("hex");
}

function computeAttachmentReplayFingerprint(
  attachments: BlueBubblesAttachment[] | undefined,
): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }
  const normalized = attachments
    .map((attachment) =>
      [
        attachment.guid?.trim() ?? "",
        attachment.transferName?.trim() ?? "",
        attachment.mimeType?.trim() ?? "",
        attachment.uti?.trim() ?? "",
        typeof attachment.totalBytes === "number" && Number.isFinite(attachment.totalBytes)
          ? String(attachment.totalBytes)
          : "",
        typeof attachment.height === "number" && Number.isFinite(attachment.height)
          ? String(attachment.height)
          : "",
        typeof attachment.width === "number" && Number.isFinite(attachment.width)
          ? String(attachment.width)
          : "",
        typeof attachment.originalROWID === "number" && Number.isFinite(attachment.originalROWID)
          ? String(attachment.originalROWID)
          : "",
      ].join("~"),
    )
    .sort();
  return createHash("sha1").update(normalized.join("|")).digest("hex");
}

function shouldIgnoreUpdatedNonConversationalEvent(
  eventType: string,
  message: NormalizedWebhookMessage,
): boolean {
  if (eventType !== "updated-message") {
    return false;
  }
  const text = message.text.trim();
  const hasEditMetadata =
    (typeof message.itemType === "number" && Number.isFinite(message.itemType)) ||
    (typeof message.dateEdited === "number" && Number.isFinite(message.dateEdited));
  const hasMediaPayload =
    (message.attachments?.length ?? 0) > 0 || Boolean(message.balloonBundleId?.trim());

  const hasAssociatedGuid = Boolean(message.associatedMessageGuid?.trim());
  const hasAssociatedSignal =
    typeof message.associatedMessageType === "number" &&
    Number.isFinite(message.associatedMessageType) &&
    message.associatedMessageType !== 0 &&
    hasAssociatedGuid;

  // UUID-like churn is only safe to drop when the payload carries no explicit
  // edit or media signal that would make it conversational.
  if (text && looksLikeBlueBubblesGuid(text) && !hasEditMetadata && !hasAssociatedSignal) {
    return true;
  }

  // In some webhook variants, explicit edit metadata is not normalized but edited text is present.
  if (text.length > 0) {
    return false;
  }

  if (hasEditMetadata || hasMediaPayload) {
    return false;
  }

  // updated-message without text or reaction metadata is delivery/playback state noise.
  if (!hasAssociatedSignal) {
    return true;
  }

  return false;
}

function buildInboundReplayKey(params: {
  target: WebhookTarget;
  eventType: string;
  message: NormalizedWebhookMessage;
}): string | undefined {
  const { target, eventType, message } = params;
  const messageId = message.messageId?.trim();
  if (!messageId) {
    return undefined;
  }

  const chatKey =
    message.chatGuid?.trim() ??
    message.chatIdentifier?.trim() ??
    (typeof message.chatId === "number" && Number.isFinite(message.chatId)
      ? String(message.chatId)
      : "");
  const itemType =
    typeof message.itemType === "number" && Number.isFinite(message.itemType)
      ? String(message.itemType)
      : "";
  const dateEdited =
    typeof message.dateEdited === "number" && Number.isFinite(message.dateEdited)
      ? String(message.dateEdited)
      : "";
  const associatedMessageGuid = message.associatedMessageGuid?.trim() ?? "";
  const associatedMessageType =
    typeof message.associatedMessageType === "number" &&
    Number.isFinite(message.associatedMessageType)
      ? String(message.associatedMessageType)
      : "";
  const replyToId = message.replyToId?.trim() ?? "";
  const replyToSenderFingerprint = computeReplayTextFingerprint(message.replyToSender ?? "");
  const replyToBodyFingerprint = computeReplayTextFingerprint(message.replyToBody ?? "");
  const textFingerprint = computeReplayTextFingerprint(message.text);
  const attachmentFingerprint = computeAttachmentReplayFingerprint(message.attachments);
  const hasBalloon = message.balloonBundleId?.trim() ? "1" : "0";

  return [
    "bluebubbles",
    target.account.accountId,
    eventType,
    message.senderId,
    chatKey,
    messageId,
    itemType,
    dateEdited,
    associatedMessageGuid,
    associatedMessageType,
    replyToId,
    replyToSenderFingerprint,
    replyToBodyFingerprint,
    textFingerprint,
    attachmentFingerprint,
    hasBalloon,
  ].join("|");
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
    if ((eventType === "message-reaction" || eventType === "reaction") && !reaction) {
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
      if (eventType === "updated-message") {
        res.statusCode = 200;
        res.end("ok");
        if (firstTarget) {
          logVerbose(
            firstTarget.core,
            firstTarget.runtime,
            "webhook ignored updated-message without parseable message payload",
          );
        }
        return true;
      }
      res.statusCode = 400;
      res.end("invalid payload");
      console.warn("[bluebubbles] webhook rejected: unable to parse message payload");
      return true;
    }

    if (message && shouldIgnoreUpdatedNonConversationalEvent(eventType, message)) {
      if (firstTarget) {
        logVerbose(
          firstTarget.core,
          firstTarget.runtime,
          `webhook ignored updated-message non-conversational payload guid=${message.messageId ?? ""} text=${message.text.trim().slice(0, 80)}`,
        );
      }
      res.statusCode = 200;
      res.end("ok");
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
      const enqueueMessage = (entry: PendingWebhookReplayRetryEntry) => {
        const debouncer = debounceRegistry.getOrCreateDebouncer(entry.target);
        void debouncer
          .enqueue({
            message: entry.message,
            target: entry.target,
            eventType: entry.eventType,
          })
          .catch((err) => {
            entry.target.runtime.error?.(
              `[${entry.target.account.accountId}] BlueBubbles webhook failed: ${String(err)}`,
            );
          });
      };
      const enqueueMessageWithReplayLifecycle = (params: {
        entry: PendingWebhookReplayRetryEntry;
        replayKey: string;
      }) => {
        const debouncer = debounceRegistry.getOrCreateDebouncer(params.entry.target);
        let retryReenqueuedFromFlushFailure = false;
        pendingInboundWebhookReplayKeys.add(params.replayKey);
        void debouncer
          .enqueue({
            message: params.entry.message,
            target: params.entry.target,
            eventType: params.entry.eventType,
            replayLifecycle: {
              onFlushSuccess: () => {
                recentInboundWebhookEvents.check(params.replayKey);
                pendingInboundWebhookReplayKeys.delete(params.replayKey);
                pendingInboundWebhookReplayRetries.delete(params.replayKey);
              },
              onFlushFailure: () => {
                pendingInboundWebhookReplayKeys.delete(params.replayKey);
                const deferredRetry = pendingInboundWebhookReplayRetries.get(params.replayKey);
                pendingInboundWebhookReplayRetries.delete(params.replayKey);
                if (!deferredRetry) {
                  return;
                }
                retryReenqueuedFromFlushFailure = true;
                enqueueMessageWithReplayLifecycle({
                  entry: deferredRetry,
                  replayKey: params.replayKey,
                });
              },
            },
          })
          .catch((err) => {
            if (!retryReenqueuedFromFlushFailure) {
              pendingInboundWebhookReplayKeys.delete(params.replayKey);
            }
            params.entry.target.runtime.error?.(
              `[${params.entry.target.account.accountId}] BlueBubbles webhook failed: ${String(err)}`,
            );
          });
      };
      const entry = { message, target, eventType };
      const replayKey = buildInboundReplayKey({ target, eventType, message });
      if (replayKey && recentInboundWebhookEvents.peek(replayKey)) {
        logVerbose(
          target.core,
          target.runtime,
          `webhook dropped replay payload sender=${message.senderId} msg=${message.messageId ?? ""}`,
        );
        res.statusCode = 200;
        res.end("ok");
        return true;
      }
      if (replayKey) {
        if (pendingInboundWebhookReplayKeys.has(replayKey)) {
          pendingInboundWebhookReplayRetries.set(replayKey, entry);
          logVerbose(
            target.core,
            target.runtime,
            `webhook deferred replay payload pending flush sender=${message.senderId} msg=${message.messageId ?? ""}`,
          );
          res.statusCode = 200;
          res.end("ok");
          return true;
        }
        enqueueMessageWithReplayLifecycle({ entry, replayKey });
      } else {
        // Route messages through debouncer to coalesce rapid-fire events
        // (e.g., text message + URL balloon arriving as separate webhooks)
        enqueueMessage(entry);
      }
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

function _resetBlueBubblesWebhookReplayState(): void {
  recentInboundWebhookEvents.clear();
  pendingInboundWebhookReplayKeys.clear();
  pendingInboundWebhookReplayRetries.clear();
}

export {
  _resetBlueBubblesShortIdState,
  _resetBlueBubblesWebhookReplayState,
  resolveBlueBubblesMessageId,
  resolveWebhookPathFromConfig,
};
