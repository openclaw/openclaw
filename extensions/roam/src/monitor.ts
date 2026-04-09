import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import {
  type RuntimeEnv,
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
  registerWebhookTargetWithPluginRoute,
  resolveWebhookPath,
  withResolvedWebhookRequestPipeline,
} from "../runtime-api.js";
import { resolveRoamAccount, type ResolvedRoamAccount } from "./accounts.js";
import { handleRoamInbound } from "./inbound.js";
import { getRoamRuntime } from "./runtime.js";
import type { CoreConfig, RoamBotIdentity, RoamInboundMessage, RoamWebhookEvent } from "./types.js";

const DEFAULT_API_BASE = "https://api.ro.am";
const DEFAULT_WEBHOOK_PATH = "/roam-webhook";

function resolveApiBase(cfg?: CoreConfig): string {
  const override = cfg?.channels?.roam?.apiBaseUrl?.replace(/\/+$/, "");
  return override ? `${override}/v1` : `${DEFAULT_API_BASE}/v1`;
}

type RoamWebhookTarget = {
  account: ResolvedRoamAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  path: string;
  /** Bot's chat address ID for self-message filtering. */
  botId?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const webhookTargets = new Map<string, RoamWebhookTarget[]>();
const webhookInFlightLimiter = createWebhookInFlightLimiter();

function parseRoamWebhookEvent(raw: unknown): RoamWebhookEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  // V1 events have type="message", userId, chatId
  // V0 events have type="chat:message:*", sender, chat
  if (typeof obj.type !== "string") {
    return null;
  }
  // Require at least one sender field (V1: userId, V0: sender)
  if (typeof obj.userId !== "string" && typeof obj.sender !== "string") {
    return null;
  }
  return obj as unknown as RoamWebhookEvent;
}

function webhookEventToInbound(
  event: RoamWebhookEvent,
  chatType: "direct" | "group",
): RoamInboundMessage {
  // V1 uses userId/chatId (bare UUIDs), V0 uses sender/chat (tagged IDs)
  const msg: RoamInboundMessage = {
    messageId: event.messageId ?? String(event.timestamp),
    chatId: event.chatId ?? event.chat ?? "",
    senderId: event.userId ?? event.sender ?? "",
    senderName: event.senderName ?? "",
    text: event.text,
    timestamp: event.timestamp,
    chatType,
    threadTimestamp: event.threadTimestamp,
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
      const body = await readJsonWebhookBodyOrReject({
        req,
        res,
        profile: "post-auth",
        emptyObjectOnEmpty: false,
        invalidJsonMessage: "invalid payload",
      });
      if (!body.ok) {
        return true;
      }

      const event = parseRoamWebhookEvent(body.value);
      if (!event) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("invalid event payload");
        return true;
      }

      // Roam webhook events don't include per-account routing info,
      // so dispatch to the first registered target on this path.
      const target = targets[0];
      if (!target) {
        res.statusCode = 404;
        res.end("no target");
        return true;
      }

      target.statusSink?.({ lastInboundAt: Date.now() });

      // Acknowledge immediately, process async
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");

      // V1 chat.message events include chatType ("dm" or "group") in the payload.
      // Fall back to V0 event type detection for backwards compatibility.
      const rawObj = body.value as Record<string, unknown>;
      const chatType: "direct" | "group" =
        rawObj.chatType === "dm" || event.type === "chat:message:dm" ? "direct" : "group";

      const message = webhookEventToInbound(event, chatType);
      target.runtime.log?.(
        `roam webhook event: type=${event.type} chatId=${message.chatId} sender=${message.senderId} chatType=${chatType}`,
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
}): Promise<void> {
  const apiBase = resolveApiBase(params.cfg);
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
}): Promise<void> {
  const apiBase = resolveApiBase(params.cfg);
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
): Promise<RoamBotIdentity | null> {
  const apiBase = resolveApiBase(cfg);
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

  const webhookPath =
    resolveWebhookPath({
      webhookPath: account.config.webhookPath,
      defaultPath: DEFAULT_WEBHOOK_PATH,
    }) ?? DEFAULT_WEBHOOK_PATH;

  const logger = core.logging.getChildLogger({
    channel: "roam",
    accountId: account.accountId,
  });

  // Fetch bot persona identity for self-message filtering
  const botIdentity = await fetchRoamBotIdentity(account.apiKey, cfg);
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
    statusSink: opts.statusSink,
  });

  // Attempt to subscribe to Roam V1 chat.message webhook events.
  // Uses webhookUrl from account config (full URL including path).
  const webhookUrl = account.config.webhookUrl?.trim() || undefined;

  if (webhookUrl) {
    try {
      await subscribeRoamWebhooks({ apiKey: account.apiKey, webhookUrl, cfg });
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

  const stop = () => {
    unregister();
    // Best-effort unsubscribe on shutdown
    if (webhookUrl) {
      unsubscribeRoamWebhooks({ apiKey: account.apiKey, webhookUrl, cfg }).catch(() => {});
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
