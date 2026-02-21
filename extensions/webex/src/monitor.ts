import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { logInboundDrop } from "openclaw/plugin-sdk";
import type { ResolvedWebexAccount, WebexWebhookEvent, WebexMessage } from "./types.js";
import { getWebexRuntime } from "./runtime.js";
import { sendWebexMessage } from "./send.js";

export type WebexRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type WebexMonitorOptions = {
  account: ResolvedWebexAccount;
  config: OpenClawConfig;
  runtime: WebexRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  webhookPath?: string;
  webhookUrl?: string;
  webhookSecret?: string;
};

const DEFAULT_WEBHOOK_PATH = "/webex-webhook";

// Registered webhook targets (path → context)
type WebhookTarget = {
  account: ResolvedWebexAccount;
  config: OpenClawConfig;
  runtime: WebexRuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  webhookSecret?: string;
};
const webhookTargets = new Map<string, WebhookTarget>();

function normalizeWebhookPath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

/**
 * Top-level HTTP handler registered at plugin load time.
 * Returns true if the request was handled, false to pass through.
 */
export async function handleWebexWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const target = webhookTargets.get(path);

  if (!target) {
    return false; // Not our path, let other handlers try
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  try {
    await handleWebexWebhook(req, res, target);
  } catch (err) {
    target.runtime.error?.(`webhook error: ${String(err)}`);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  }
  return true;
}

/**
 * Start monitoring for a Webex account. Registers the webhook target and
 * registers the webhook with Webex API. Resolves when aborted.
 */
export async function monitorWebexProvider(options: WebexMonitorOptions): Promise<void> {
  const { account, config, runtime, abortSignal, statusSink, webhookPath, webhookUrl, webhookSecret } = options;

  const resolvedWebhookPath = normalizeWebhookPath(
    webhookPath || account.config.webhookPath || DEFAULT_WEBHOOK_PATH
  );
  const resolvedWebhookUrl = webhookUrl || account.config.webhookUrl;
  const resolvedWebhookSecret = webhookSecret || account.config.webhookSecret;

  if (!resolvedWebhookUrl) {
    throw new Error("webhookUrl is required. Configure channels.webex.webhookUrl with your public URL.");
  }

  // Register this account as a webhook target
  webhookTargets.set(resolvedWebhookPath, {
    account,
    config,
    runtime,
    statusSink,
    webhookSecret: resolvedWebhookSecret,
  });
  runtime.log?.(`[${account.accountId}] webhook target registered at ${resolvedWebhookPath}`);

  // Register/update webhook with Webex API
  const fullWebhookUrl = resolvedWebhookUrl.replace(/\/+$/, "") + resolvedWebhookPath;
  await registerWebexWebhook(account.token, fullWebhookUrl, resolvedWebhookSecret);
  runtime.log?.(`[${account.accountId}] registered webhook with Webex: ${fullWebhookUrl}`);

  // Keep alive until aborted
  return new Promise<void>((resolve) => {
    const cleanup = () => {
      webhookTargets.delete(resolvedWebhookPath);
      runtime.log?.(`[${account.accountId}] webhook monitor stopped`);
      resolve();
    };
    if (abortSignal.aborted) {
      cleanup();
      return;
    }
    abortSignal.addEventListener("abort", cleanup, { once: true });
  });
}

// ── Webhook handling ────────────────────────────────────────────────

async function handleWebexWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  context: WebhookTarget,
): Promise<void> {
  const { account, config, runtime, statusSink, webhookSecret } = context;

  // Read body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf-8");

  // Validate secret
  if (webhookSecret) {
    const provided = req.headers["x-webex-secret"] as string;
    if (provided !== webhookSecret) {
      runtime.error?.(`[${account.accountId}] webhook secret mismatch`);
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }
  }

  let event: WebexWebhookEvent;
  try {
    event = JSON.parse(body);
  } catch {
    res.statusCode = 400;
    res.end("Bad Request");
    return;
  }

  // Only handle new messages
  if (event.resource !== "messages" || event.event !== "created") {
    res.statusCode = 200;
    res.end("OK");
    return;
  }

  const messageId = event.data?.id;
  if (!messageId) {
    res.statusCode = 400;
    res.end("Bad Request");
    return;
  }

  // Respond immediately (Webex wants fast 200s)
  res.statusCode = 200;
  res.end("OK");

  // Fetch full message
  const message = await fetchWebexMessage(account.token, messageId);
  if (!message) {
    runtime.error?.(`[${account.accountId}] failed to fetch message ${messageId}`);
    return;
  }

  // Skip self messages
  const botInfo = await getBotInfo(account.token);
  if (botInfo && message.personId === botInfo.id) {
    return;
  }

  if (statusSink) {
    statusSink({ lastInboundAt: Date.now() });
  }

  await processWebexMessage(message, { config, account, runtime, statusSink });
}

// ── Message processing ──────────────────────────────────────────────

function logVerbose(runtime: WebexRuntimeEnv, msg: string): void {
  runtime.log?.(`[webex] ${msg}`);
}

async function processWebexMessage(
  message: WebexMessage,
  context: {
    config: OpenClawConfig;
    account: ResolvedWebexAccount;
    runtime: WebexRuntimeEnv;
    statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  },
): Promise<void> {
  const { config, account, runtime, statusSink } = context;
  const core = getWebexRuntime();

  const text = (message.text ?? "").trim();
  if (!text) {
    logVerbose(runtime, `drop: empty text sender=${message.personEmail}`);
    return;
  }

  const isGroup = message.roomType !== "direct";
  const chatType = isGroup ? "group" : "direct";
  const senderId = message.personEmail ?? message.personId ?? "unknown";

  // DM policy check
  const dmPolicy = account.config.dmPolicy || "pairing";
  const configAllowFrom = (account.config.allowFrom ?? []).map((entry: string) => String(entry));
  const storeAllowFrom = await core.channel.pairing
    .readAllowFromStore("webex")
    .catch(() => [] as string[]);
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom]
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean);

  if (!isGroup) {
    if (dmPolicy === "disabled") {
      logInboundDrop({
        log: (msg: string) => logVerbose(runtime, msg),
        channel: "webex",
        reason: "dm-disabled",
        target: senderId,
      });
      return;
    }

    if (dmPolicy !== "open") {
      const normalizedSender = senderId.toLowerCase();
      const isAllowed = effectiveAllowFrom.some(
        (entry) =>
          entry === normalizedSender ||
          entry === (message.personId ?? "").toLowerCase(),
      );

      if (!isAllowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "webex",
            id: senderId,
            meta: { name: message.personEmail },
          });
          runtime.log?.(`[webex] pairing request sender=${senderId} created=${created}`);
          if (created) {
            try {
              await sendWebexMessage(senderId, core.channel.pairing.buildPairingReply({
                channel: "webex",
                idLine: `Your Webex email: ${senderId}`,
                code,
              }), { accountId: account.accountId });
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              runtime.error?.(`[webex] pairing reply failed sender=${senderId}: ${String(err)}`);
            }
          }
        } else {
          logInboundDrop({
            log: (msg: string) => logVerbose(runtime, msg),
            channel: "webex",
            reason: `dm-unauthorized (dmPolicy=${dmPolicy})`,
            target: senderId,
          });
        }
        return;
      }
    }
  }

  // Resolve routing
  const peerId = isGroup ? (message.roomId ?? "group") : senderId;
  const outboundTarget = isGroup ? message.roomId! : senderId;

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "webex",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: peerId,
    },
  });

  // Mention gating for group messages
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config, route.agentId);
  const wasMentioned = isGroup
    ? core.channel.mentions.matchesMentionPatterns(text, mentionRegexes)
    : true;

  // In groups, skip if not mentioned (unless it's a command)
  if (isGroup && !wasMentioned && mentionRegexes.length > 0) {
    logVerbose(runtime, `drop: group message without mention sender=${senderId}`);
    return;
  }

  // Resolve store path and record session
  const storePath = core.channel.session.resolveStorePath(
    (config as any).session?.store,
    { agentId: route.agentId },
  );

  // Build envelope for the agent
  const fromLabel = message.personEmail ?? senderId;
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Webex",
    from: fromLabel,
    timestamp: new Date(message.created).getTime(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: text,
  });

  // Record inbound session metadata
  try {
    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey: route.sessionKey,
      ctx: {
        channel: "webex",
        accountId: account.accountId,
        chatType,
        peer: peerId,
        sender: senderId,
      },
      updateLastRoute: {
        sessionKey: route.sessionKey,
        channel: "webex",
        to: `webex:${outboundTarget}`,
        accountId: account.accountId,
      },
      onRecordError: (err: unknown) => {
        runtime.error?.(`[webex] session record error: ${String(err)}`);
      },
    });
  } catch (err) {
    runtime.error?.(`[webex] session record error: ${String(err)}`);
  }

  // Build context payload (same shape as other channel plugins)
  const ctxPayload = {
    Body: body,
    BodyForAgent: body,
    RawBody: text,
    CommandBody: text,
    BodyForCommands: text,
    From: isGroup ? `group:${peerId}` : `webex:${senderId}`,
    To: `webex:${outboundTarget}`,
    SessionKey: route.sessionKey,
    AccountId: account.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    SenderName: message.personEmail ?? undefined,
    SenderId: senderId,
    Provider: "webex",
    Surface: "webex",
    MessageSid: message.id,
    Timestamp: new Date(message.created).getTime(),
    OriginatingChannel: "webex",
    OriginatingTo: `webex:${outboundTarget}`,
    WasMentioned: wasMentioned,
    CommandAuthorized: !isGroup || wasMentioned,
  };

  // Send "Thinking..." indicator (Webex has no typing API, so we fake it)
  let thinkingMessageId: string | undefined;
  try {
    const thinkingResult = await sendWebexMessage(outboundTarget, "🤔 Thinking...", {
      accountId: account.accountId,
    });
    if (thinkingResult.ok && thinkingResult.messageId) {
      thinkingMessageId = thinkingResult.messageId;
    }
  } catch {
    // Non-critical — continue without indicator
  }

  let thinkingCleared = false;
  const clearThinkingMessage = async () => {
    if (thinkingCleared || !thinkingMessageId) return;
    thinkingCleared = true;
    try {
      await deleteWebexMessage(account.token, thinkingMessageId);
    } catch {
      // Best effort — ignore deletion failures
    }
  };

  try {
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config,
      dispatcherOptions: {
        deliver: async (payload: any) => {
          const replyText = payload.text ?? "";
          if (!replyText.trim()) return;

          // Clear thinking indicator before first real reply
          await clearThinkingMessage();

          const tableMode = core.channel.text.resolveMarkdownTableMode({
            cfg: config,
            channel: "webex",
            accountId: account.accountId,
          });
          const formattedText = core.channel.text.convertMarkdownTables(replyText, tableMode);

          // Handle media
          const mediaList = payload.mediaUrls?.length
            ? payload.mediaUrls
            : payload.mediaUrl
              ? [payload.mediaUrl]
              : [];

          if (mediaList.length > 0) {
            let first = true;
            for (const mediaUrl of mediaList) {
              const caption = first ? formattedText : undefined;
              first = false;
              await sendWebexMessage(outboundTarget, caption ?? "", {
                accountId: account.accountId,
                markdown: caption,
                files: [mediaUrl],
              });
              statusSink?.({ lastOutboundAt: Date.now() });
            }
          } else {
            await sendWebexMessage(outboundTarget, formattedText, {
              accountId: account.accountId,
              markdown: formattedText,
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          }
        },
        onError: (err: any) => {
          runtime.error?.(`[webex] reply delivery failed: ${String(err)}`);
        },
      },
      replyOptions: {},
    });
  } catch (err) {
    runtime.error?.(`[${account.accountId}] message processing error: ${String(err)}`);
  } finally {
    // Always clean up thinking message
    await clearThinkingMessage();
  }
}

// ── Webex API helpers ───────────────────────────────────────────────

async function deleteWebexMessage(token: string, messageId: string): Promise<void> {
  await fetch(`https://webexapis.com/v1/messages/${messageId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function fetchWebexMessage(token: string, messageId: string): Promise<WebexMessage | null> {
  try {
    const resp = await fetch(`https://webexapis.com/v1/messages/${messageId}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  }
}

let cachedBotInfo: { id: string; email: string } | null = null;
async function getBotInfo(token: string): Promise<{ id: string; email: string } | null> {
  if (cachedBotInfo) return cachedBotInfo;
  try {
    const resp = await fetch("https://webexapis.com/v1/people/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    cachedBotInfo = { id: data.id, email: data.emails?.[0] };
    return cachedBotInfo;
  } catch {
    return null;
  }
}

async function registerWebexWebhook(token: string, webhookUrl: string, secret?: string): Promise<void> {
  try {
    // List existing webhooks
    const listResp = await fetch("https://webexapis.com/v1/webhooks", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (listResp.ok) {
      const { items } = await listResp.json();
      // Update existing or skip if already correct
      const existing = items?.find(
        (w: any) => w.resource === "messages" && w.event === "created" && w.name === "OpenClaw Webex Bot",
      );
      if (existing) {
        if (existing.targetUrl === webhookUrl) return; // Already correct
        // Update existing webhook
        await fetch(`https://webexapis.com/v1/webhooks/${existing.id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "OpenClaw Webex Bot",
            targetUrl: webhookUrl,
            ...(secret ? { secret } : {}),
          }),
        });
        return;
      }
    }

    // Create new webhook
    const resp = await fetch("https://webexapis.com/v1/webhooks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "OpenClaw Webex Bot",
        targetUrl: webhookUrl,
        resource: "messages",
        event: "created",
        ...(secret ? { secret } : {}),
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${err}`);
    }
  } catch (err) {
    throw new Error(`Webhook registration failed: ${String(err)}`);
  }
}
