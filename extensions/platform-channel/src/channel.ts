import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ChannelPlugin,
  ChannelOutboundAdapter,
  ChannelGatewayAdapter,
  OpenClawConfig,
  OutboundDeliveryResult,
} from "openclaw/plugin-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { getPlatformChannelRuntime } from "./runtime.js";

// Simple resolved account type - just needs an ID
type ResolvedPlatformAccount = {
  accountId: string;
  webhookUrl?: string;
  secret?: string;
};

/**
 * Inbound message from else-platform.
 */
export type PlatformInboundMessage = {
  /** User ID from else-platform */
  from: string;
  /** Message text */
  body: string;
  /** Optional session override */
  sessionKey?: string;
  /** Conversation ID */
  conversationId?: string;
  /** Message ID */
  messageId?: string;
  /** Human-readable sender name */
  senderName?: string;
};

type PlatformRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type WebhookTarget = {
  account: ResolvedPlatformAccount;
  config: OpenClawConfig;
  runtime: PlatformRuntimeEnv;
  core: PluginRuntime;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const CHANNEL_ID = "platform-channel" as const;
const DEFAULT_WEBHOOK_PATH = "/platform/webhook";

// Webhook targets map (following BlueBubbles pattern)
const webhookTargets = new Map<string, WebhookTarget[]>();

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

/**
 * Register a webhook target for the platform channel.
 * Returns a cleanup function to unregister.
 */
export function registerPlatformWebhookTarget(target: WebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  webhookTargets.set(key, next);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}

/**
 * Read JSON body from incoming request.
 */
async function readJsonBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: false, error: "empty payload" });
          return;
        }
        resolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  if (!record) {
    return undefined;
  }
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Parse and validate the inbound message payload.
 */
function parseInboundMessage(payload: Record<string, unknown>): PlatformInboundMessage | null {
  const from = readString(payload, "from");
  const body = readString(payload, "body");

  if (!from || !body) {
    return null;
  }

  return {
    from,
    body,
    sessionKey: readString(payload, "sessionKey"),
    conversationId: readString(payload, "conversationId"),
    messageId: readString(payload, "messageId"),
    senderName: readString(payload, "senderName"),
  };
}

/**
 * Deliver a reply back to else-platform via outbound webhook.
 */
async function deliverPlatformReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; replyToId?: string };
  to: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, to, statusSink } = params;
  const text = payload.text ?? "";

  if (!text.trim()) {
    return;
  }

  const webhookUrl = process.env.ELSE_PLATFORM_WEBHOOK_URL;
  const secret = process.env.ELSE_PLATFORM_SECRET;

  if (!webhookUrl) {
    console.error("[platform-channel] ELSE_PLATFORM_WEBHOOK_URL not configured");
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "X-Platform-Secret": secret } : {}),
      },
      body: JSON.stringify({
        to,
        text: text.trim(),
        replyToId: payload.replyToId,
      }),
    });

    if (!response.ok) {
      console.error(
        `[platform-channel] Webhook delivery failed: ${response.status} ${response.statusText}`,
      );
      return;
    }

    statusSink?.({ lastOutboundAt: Date.now() });
  } catch (error) {
    console.error(`[platform-channel] Webhook delivery error: ${String(error)}`);
  }
}

/**
 * Process an inbound message and dispatch to the agent.
 */
async function processInboundMessage(params: {
  message: PlatformInboundMessage;
  target: WebhookTarget;
}): Promise<void> {
  const { message, target } = params;
  const { account, config, runtime, core, statusSink } = target;

  const rawBody = message.body.trim();
  if (!rawBody) {
    runtime.log?.("[platform-channel] drop: empty body");
    return;
  }

  runtime.log?.(`[platform-channel] inbound from=${message.from} bodyLen=${rawBody.length}`);
  statusSink?.({ lastInboundAt: Date.now() });

  // Resolve routing
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: "dm",
      id: message.from,
    },
  });

  // Use provided sessionKey or fall back to route
  const sessionKey = message.sessionKey?.trim() || route.sessionKey;

  // Resolve session store path
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });

  // Get envelope formatting options
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);

  // Read previous session timestamp for envelope
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey,
  });

  // Format the body with envelope (timestamp context)
  const fromLabel = message.senderName || message.from;
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Platform",
    from: fromLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  // Build finalized inbound context
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `platform-channel:${message.from}`,
    To: `platform-channel:${account.accountId}`,
    SessionKey: sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: fromLabel,
    SenderName: message.senderName || undefined,
    SenderId: message.from,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: message.messageId,
    Timestamp: Date.now(),
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `platform-channel:${account.accountId}`,
    CommandAuthorized: true, // Platform messages are trusted
  });

  // Record session metadata
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`[platform-channel] failed updating session meta: ${String(err)}`);
    },
  });

  // Dispatch to agent and collect replies
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverPlatformReply({
          payload: payload as {
            text?: string;
            mediaUrls?: string[];
            mediaUrl?: string;
            replyToId?: string;
          },
          to: message.from,
          statusSink,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`[platform-channel] ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

/**
 * HTTP handler for platform webhook requests.
 * Returns true if the request was handled, false to pass to next handler.
 */
export async function handlePlatformWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const targets = webhookTargets.get(path);

  if (!targets || targets.length === 0) {
    return false;
  }

  // Only accept POST requests
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  // Parse JSON body
  const body = await readJsonBody(req, 1024 * 1024); // 1MB limit
  if (!body.ok) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    console.warn(`[platform-channel] webhook rejected: ${body.error ?? "invalid payload"}`);
    return true;
  }

  const payload = asRecord(body.value) ?? {};
  const firstTarget = targets[0];

  if (firstTarget) {
    firstTarget.runtime.log?.(
      `[platform-channel] webhook received path=${path} keys=${Object.keys(payload).join(",") || "none"}`,
    );
  }

  // Validate secret header if configured
  const configuredSecret = process.env.ELSE_PLATFORM_SECRET?.trim();
  if (configuredSecret) {
    const headerSecret = req.headers["x-platform-secret"] ?? req.headers["authorization"];
    const providedSecret = Array.isArray(headerSecret) ? headerSecret[0] : headerSecret;

    if (providedSecret?.trim() !== configuredSecret) {
      // Allow localhost requests without secret
      const remote = req.socket?.remoteAddress ?? "";
      if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
        res.statusCode = 401;
        res.end("unauthorized");
        console.warn("[platform-channel] webhook rejected: invalid secret");
        return true;
      }
    }
  }

  // Parse the inbound message
  const message = parseInboundMessage(payload);
  if (!message) {
    res.statusCode = 400;
    res.end("invalid payload: missing 'from' or 'body'");
    console.warn("[platform-channel] webhook rejected: missing required fields");
    return true;
  }

  // Process message for all matching targets
  for (const target of targets) {
    processInboundMessage({ message, target }).catch((err) => {
      target.runtime.error?.(
        `[${target.account.accountId}] platform-channel webhook failed: ${String(err)}`,
      );
    });
  }

  // Respond immediately (processing happens async)
  res.statusCode = 200;
  res.end("ok");

  if (firstTarget) {
    firstTarget.runtime.log?.(
      `[platform-channel] webhook accepted from=${message.from} bodyLen=${message.body.length}`,
    );
  }

  return true;
}

const outbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  sendText: async (ctx): Promise<OutboundDeliveryResult> => {
    const webhookUrl = process.env.ELSE_PLATFORM_WEBHOOK_URL;
    const secret = process.env.ELSE_PLATFORM_SECRET;

    if (!webhookUrl) {
      return {
        ok: false,
        error: new Error("ELSE_PLATFORM_WEBHOOK_URL not configured"),
      };
    }

    try {
      // Use native fetch (Node 18+)
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { "X-Platform-Secret": secret } : {}),
        },
        body: JSON.stringify({
          to: ctx.to,
          text: ctx.text,
          replyToId: ctx.replyToId,
          threadId: ctx.threadId,
        }),
      });

      if (!response.ok) {
        return {
          ok: false,
          error: new Error(`Webhook failed: ${response.status} ${response.statusText}`),
        };
      }

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  },
};

const gateway: ChannelGatewayAdapter<ResolvedPlatformAccount> = {
  startAccount: async (ctx) => {
    const webhookPath = process.env.ELSE_PLATFORM_WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH;

    ctx.log?.info(`Starting platform-channel (webhook path: ${webhookPath})`);

    const core = getPlatformChannelRuntime();

    // Register webhook target
    const unregister = registerPlatformWebhookTarget({
      account: ctx.account,
      config: ctx.cfg,
      runtime: {
        log: (msg) => ctx.log?.info(msg),
        error: (msg) => ctx.log?.error(msg),
      },
      core,
      path: webhookPath,
      statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
    });

    // Handle cleanup on abort
    ctx.abortSignal?.addEventListener("abort", () => {
      unregister();
      ctx.log?.info("Stopping platform-channel webhook target");
    });

    return {
      mode: "webhook",
      webhookPath,
      status: "running",
    };
  },
  stopAccount: async (ctx) => {
    ctx.log?.info("Stopping platform-channel server");
    // Cleanup is handled via AbortSignal
  },
};

export const platformChannelPlugin: ChannelPlugin<ResolvedPlatformAccount> = {
  id: "platform-channel",
  meta: {
    name: "Platform Channel",
    description: "Receives messages from else-platform via HTTP",
    quickstartAllowFrom: false,
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: true,
    media: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.platform-channel"] },
  config: {
    listAccountIds: (_cfg: OpenClawConfig) => ["default"],
    resolveAccount: (_cfg: OpenClawConfig, accountId?: string | null): ResolvedPlatformAccount => {
      return {
        accountId: accountId || "default",
        webhookUrl: process.env.ELSE_PLATFORM_WEBHOOK_URL,
        secret: process.env.ELSE_PLATFORM_SECRET,
      };
    },
    defaultAccountId: () => "default",
  },
  outbound,
  gateway,
};
