import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import {
  type RuntimeEnv,
  createWebhookInFlightLimiter,
  readWebhookBodyOrReject,
  registerWebhookTargetWithPluginRoute,
  resolveWebhookPath,
  withResolvedWebhookRequestPipeline,
} from "../runtime-api.js";
import { resolveRoamAccount, type ResolvedRoamAccount } from "./accounts.js";
import { resolveApiBase } from "./api-base.js";
import { handleRoamInbound } from "./inbound.js";
import { getRoamRuntime } from "./runtime.js";
import type { CoreConfig, RoamBotIdentity, RoamInboundMessage, RoamWebhookEvent } from "./types.js";

const DEFAULT_WEBHOOK_PATH_PREFIX = "/roam-webhook";

/** Max age for webhook timestamps before rejecting as replay (5 minutes). */
const WEBHOOK_TIMESTAMP_TOLERANCE_S = 300;

type RoamWebhookTarget = {
  account: ResolvedRoamAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  path: string;
  /** Bot's chat address ID for self-message filtering. */
  botId?: string;
  /** Standard-webhooks signing secret for verifying inbound payloads. */
  secret?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

/**
 * Verify a standard-webhooks signature (https://www.standardwebhooks.com).
 * Returns true if the signature is valid, false otherwise.
 */
export function verifyStandardWebhookSignature(
  secret: string,
  headers: IncomingMessage["headers"],
  rawBody: string,
): boolean {
  const msgId = headers["webhook-id"] as string | undefined;
  const msgTimestamp = headers["webhook-timestamp"] as string | undefined;
  const msgSignature = headers["webhook-signature"] as string | undefined;

  if (!msgId || !msgTimestamp || !msgSignature) {
    return false;
  }

  // Reject stale timestamps (replay protection)
  const timestampSec = Number.parseInt(msgTimestamp, 10);
  if (Number.isNaN(timestampSec)) {
    return false;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestampSec) > WEBHOOK_TIMESTAMP_TOLERANCE_S) {
    return false;
  }

  // Decode the secret key (strip "whsec_" prefix if present, then base64-decode)
  const secretPayload = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const secretBytes = Buffer.from(secretPayload, "base64");

  // Compute expected signature: HMAC-SHA256(key, "${msgId}.${msgTimestamp}.${rawBody}")
  const signedContent = `${msgId}.${msgTimestamp}.${rawBody}`;
  const expectedSig = createHmac("sha256", secretBytes).update(signedContent).digest("base64");

  // The header may contain multiple space-separated "v1,<base64>" signatures
  const signatures = msgSignature.split(" ");
  for (const sig of signatures) {
    const parts = sig.split(",");
    if (parts[0] === "v1" && parts[1] === expectedSig) {
      return true;
    }
  }
  return false;
}

let warnedNoSecret = false;

const webhookTargets = new Map<string, RoamWebhookTarget[]>();
const webhookInFlightLimiter = createWebhookInFlightLimiter();

function parseRoamWebhookEvent(raw: unknown): RoamWebhookEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.type !== "message") {
    return null;
  }
  if (typeof obj.userId !== "string") {
    return null;
  }
  if (typeof obj.chatId !== "string") {
    return null;
  }
  if (typeof obj.timestamp !== "number" || !Number.isFinite(obj.timestamp)) {
    return null;
  }
  // Normalize text to string — media-only events may omit it.
  if (obj.text !== undefined && typeof obj.text !== "string") {
    return null;
  }
  return obj as unknown as RoamWebhookEvent;
}

function webhookEventToInbound(event: RoamWebhookEvent): RoamInboundMessage {
  // Roam timestamps are microsecond-precision; convert to milliseconds for downstream use.
  const timestampMs = Math.floor(event.timestamp / 1000);
  // Derive chat type from the event's chatType field ("dm" → "direct", "channel" → "group").
  const chatType: "direct" | "group" = event.chatType === "dm" ? "direct" : "group";
  const msg: RoamInboundMessage = {
    messageId: event.messageId ?? String(event.timestamp),
    chatId: event.chatId,
    senderId: event.userId,
    senderName: "",
    text: event.text,
    timestamp: timestampMs,
    chatType,
    threadTimestamp: event.threadTimestamp ? Math.floor(event.threadTimestamp / 1000) : undefined,
  };

  // Extract media URLs from attached items
  if (event.items?.length) {
    const mediaUrls: string[] = [];
    const mediaTypes: string[] = [];
    for (const item of event.items) {
      if (item.url) {
        mediaUrls.push(item.url);
        mediaTypes.push(item.mime ?? "application/octet-stream");
      }
    }
    if (mediaUrls.length > 0) {
      msg.mediaUrls = mediaUrls;
      msg.mediaTypes = mediaTypes;
    }
  }

  return msg;
}

async function handleRoamWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  return await withResolvedWebhookRequestPipeline({
    req,
    res,
    targetsByPath: webhookTargets,
    allowMethods: ["POST"],
    requireJsonContentType: true,
    inFlightLimiter: webhookInFlightLimiter,
    handle: async ({ targets }) => {
      // Read raw body first — needed for standard-webhooks signature verification.
      const rawResult = await readWebhookBodyOrReject({
        req,
        res,
        profile: "post-auth",
        invalidBodyMessage: "invalid payload",
      });
      if (!rawResult.ok) {
        return true;
      }
      const rawBody = rawResult.value;

      // Resolve the target for this path.
      const target = targets[0];
      if (!target) {
        res.statusCode = 404;
        res.end("no target");
        return true;
      }

      // Verify standard-webhooks signature when a secret is configured.
      if (target.secret) {
        if (!verifyStandardWebhookSignature(target.secret, req.headers, rawBody)) {
          res.statusCode = 401;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("invalid webhook signature");
          return true;
        }
      } else if (!warnedNoSecret) {
        warnedNoSecret = true;
        target.runtime.log?.(
          "roam: no webhookSecret configured — webhook requests are not authenticated. " +
            "Set channels.roam.webhookSecret with your Roam signing key for production use.",
        );
      }

      // Parse JSON body.
      let parsed: unknown;
      try {
        parsed = rawBody.trim() ? JSON.parse(rawBody) : undefined;
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("invalid JSON payload");
        return true;
      }

      const event = parseRoamWebhookEvent(parsed);
      if (!event) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("invalid event payload");
        return true;
      }

      target.statusSink?.({ lastInboundAt: Date.now() });

      // Acknowledge immediately, process async
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");

      const message = webhookEventToInbound(event);
      target.runtime.log?.(
        `roam webhook event: type=${event.type} chatId=${message.chatId} sender=${message.senderId} chatType=${message.chatType}`,
      );
      const core = getRoamRuntime();
      core.channel.activity.record({
        channel: "roam",
        accountId: target.account.accountId,
        direction: "inbound",
        at: message.timestamp,
      });

      handleRoamInbound({
        message,
        account: target.account,
        config: target.config,
        runtime: target.runtime,
        botId: target.botId,
        statusSink: target.statusSink,
      }).catch((err) => {
        target.runtime.error?.(
          `[${target.account.accountId}] Roam webhook handler failed: ${String(err)}`,
        );
      });

      return true;
    },
  });
}

function registerRoamWebhookTarget(target: RoamWebhookTarget): () => void {
  return registerWebhookTargetWithPluginRoute({
    targetsByPath: webhookTargets,
    target,
    route: {
      auth: "plugin",
      match: "exact",
      pluginId: "roam",
      source: "roam-webhook",
      accountId: target.account.accountId,
      log: target.runtime.log,
      handler: async (req, res) => {
        const handled = await handleRoamWebhookRequest(req, res);
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
        }
      },
    },
  }).unregister;
}

const WEBHOOK_EVENT = "chat.message";

/** Subscribe to Roam V1 chat.message webhook events for the given account. */
async function subscribeRoamWebhooks(params: {
  apiKey: string;
  webhookUrl: string;
  cfg?: CoreConfig;
  accountApiBaseUrl?: string;
}): Promise<void> {
  const apiBase = resolveApiBase(params.cfg, params.accountApiBaseUrl);
  const response = await fetch(`${apiBase}/webhook.subscribe`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: params.webhookUrl, event: WEBHOOK_EVENT }),
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Roam webhook.subscribe failed: ${response.status} ${errorBody}`);
  }
}

/** Unsubscribe from Roam webhook events. */
async function unsubscribeRoamWebhooks(params: {
  apiKey: string;
  webhookUrl: string;
  cfg?: CoreConfig;
  accountApiBaseUrl?: string;
}): Promise<void> {
  const apiBase = resolveApiBase(params.cfg, params.accountApiBaseUrl);
  await fetch(`${apiBase}/webhook.unsubscribe`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: params.webhookUrl, event: WEBHOOK_EVENT }),
  }).catch(() => {
    // Best-effort unsubscribe on shutdown
  });
}

/** Fetch bot persona identity from token.info. Returns null on failure. */
async function fetchRoamBotIdentity(
  apiKey: string,
  cfg?: CoreConfig,
  accountApiBaseUrl?: string,
): Promise<RoamBotIdentity | null> {
  const apiBase = resolveApiBase(cfg, accountApiBaseUrl);
  try {
    const response = await fetch(`${apiBase}/token.info`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as {
      bot?: { id?: string; name?: string; imageUrl?: string };
    };
    if (!data.bot?.id || !data.bot?.name) {
      return null;
    }
    return {
      id: data.bot.id,
      name: data.bot.name,
      imageUrl: data.bot.imageUrl || undefined,
    };
  } catch {
    return null;
  }
}

export type RoamMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export async function monitorRoamProvider(opts: RoamMonitorOptions): Promise<{ stop: () => void }> {
  const core = getRoamRuntime();
  const cfg = opts.config ?? (core.config.loadConfig() as CoreConfig);
  const account = resolveRoamAccount({ cfg, accountId: opts.accountId });
  const runtime: RuntimeEnv = resolveLoggerBackedRuntime(
    opts.runtime,
    core.logging.getChildLogger(),
  );

  if (!account.apiKey) {
    throw new Error(`Roam API key not configured for account "${account.accountId}"`);
  }

  // Each account gets a unique webhook path to avoid cross-account routing.
  // Default: /roam-webhook (for the default account) or /roam-webhook-<accountId>.
  // When webhookUrl is set, derive the local route path from its pathname.
  const defaultPath =
    account.accountId === "default"
      ? DEFAULT_WEBHOOK_PATH_PREFIX
      : `${DEFAULT_WEBHOOK_PATH_PREFIX}-${account.accountId}`;
  const webhookPath =
    resolveWebhookPath({
      webhookPath: account.config.webhookPath,
      webhookUrl: account.config.webhookUrl,
      defaultPath,
    }) ?? defaultPath;

  const logger = core.logging.getChildLogger({
    channel: "roam",
    accountId: account.accountId,
  });

  // Fetch bot persona identity for self-message filtering
  const accountApiBaseUrl = account.config.apiBaseUrl;
  const botIdentity = await fetchRoamBotIdentity(account.apiKey, cfg, accountApiBaseUrl);
  if (botIdentity) {
    account.botIdentity = botIdentity;
    logger.info(`[${account.accountId}] Roam bot persona: ${botIdentity.name} (${botIdentity.id})`);
  } else {
    logger.warn(
      `[${account.accountId}] Could not fetch bot identity from token.info; self-message filtering disabled`,
    );
  }

  // Register the HTTP route on the gateway
  const unregister = registerRoamWebhookTarget({
    account,
    config: cfg,
    runtime,
    path: webhookPath,
    botId: botIdentity?.id,
    secret: account.config.webhookSecret?.trim() || undefined,
    statusSink: opts.statusSink,
  });

  // Attempt to subscribe to Roam V1 chat.message webhook events.
  // Uses webhookUrl from account config (full URL including path).
  const webhookUrl = account.config.webhookUrl?.trim() || undefined;

  if (webhookUrl) {
    try {
      await subscribeRoamWebhooks({ apiKey: account.apiKey, webhookUrl, cfg, accountApiBaseUrl });
      logger.info(`[${account.accountId}] Roam webhooks subscribed at ${webhookUrl}`);
    } catch (err) {
      logger.warn(
        `[${account.accountId}] Roam webhook subscription failed: ${String(err)}. Register webhooks manually in Roam admin.`,
      );
    }
  } else {
    logger.info(
      `[${account.accountId}] Roam webhook route registered at ${webhookPath} (set channels.roam.webhookUrl to enable auto-subscription)`,
    );
  }

  let stopped = false;
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    unregister();
    // Best-effort unsubscribe on shutdown
    if (webhookUrl) {
      unsubscribeRoamWebhooks({ apiKey: account.apiKey, webhookUrl, cfg, accountApiBaseUrl }).catch(
        () => {},
      );
    }
  };

  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) {
      stop();
    } else {
      opts.abortSignal.addEventListener("abort", stop, { once: true });
    }
  }

  return { stop };
}
