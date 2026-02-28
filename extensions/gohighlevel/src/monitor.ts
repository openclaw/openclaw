import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  createScopedPairingAccess,
  createReplyPrefixOptions,
  readRequestBodyWithLimit,
  registerWebhookTarget,
  rejectNonPostWebhookRequest,
  resolveWebhookPath,
  resolveWebhookTargets,
  requestBodyErrorToText,
  isRequestBodyLimitError,
} from "openclaw/plugin-sdk";
import type { ResolvedGoHighLevelAccount } from "./accounts.js";
import { sendGHLMessage } from "./api.js";
import { verifyGHLSignature } from "./auth.js";
import { getGoHighLevelRuntime } from "./runtime.js";
import type { GHLWebhookPayload } from "./types.js";

export type GoHighLevelRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type GoHighLevelMonitorOptions = {
  account: ResolvedGoHighLevelAccount;
  config: OpenClawConfig;
  runtime: GoHighLevelRuntimeEnv;
  abortSignal: AbortSignal;
  webhookPath?: string;
  webhookUrl?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type GoHighLevelCoreRuntime = ReturnType<typeof getGoHighLevelRuntime>;

type WebhookTarget = {
  account: ResolvedGoHighLevelAccount;
  config: OpenClawConfig;
  runtime: GoHighLevelRuntimeEnv;
  core: GoHighLevelCoreRuntime;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const webhookTargets = new Map<string, WebhookTarget[]>();

function logVerbose(core: GoHighLevelCoreRuntime, runtime: GoHighLevelRuntimeEnv, message: string) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[gohighlevel] ${message}`);
  }
}

export function registerGoHighLevelWebhookTarget(target: WebhookTarget): () => void {
  return registerWebhookTarget(webhookTargets, target).unregister;
}

export async function handleGoHighLevelWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const resolved = resolveWebhookTargets(req, webhookTargets);
  if (!resolved) {
    return false;
  }
  const { targets } = resolved;

  if (rejectNonPostWebhookRequest(req, res)) {
    return true;
  }

  // Read raw body for signature verification before JSON parsing
  let rawBody: string;
  try {
    rawBody = await readRequestBodyWithLimit(req, {
      maxBytes: 1024 * 1024,
      timeoutMs: 30_000,
    });
  } catch (err) {
    if (isRequestBodyLimitError(err)) {
      res.statusCode = 413;
      res.end(requestBodyErrorToText("PAYLOAD_TOO_LARGE"));
      return true;
    }
    res.statusCode = 400;
    res.end("invalid request body");
    return true;
  }

  if (!rawBody.trim()) {
    res.statusCode = 400;
    res.end("empty body");
    return true;
  }

  let payload: GHLWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as GHLWebhookPayload;
  } catch {
    res.statusCode = 400;
    res.end("invalid JSON");
    return true;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    res.statusCode = 400;
    res.end("invalid payload");
    return true;
  }

  // Find matching target; verify signature if webhook secret is configured
  const signatureHeader = String(req.headers["x-ghl-signature"] ?? "");
  let matchedTarget: WebhookTarget | null = null;

  for (const target of targets) {
    const secret = target.account.config.webhookSecret?.trim();
    if (secret) {
      if (!verifyGHLSignature({ signature: signatureHeader, body: rawBody, secret })) {
        continue;
      }
    }
    matchedTarget = target;
    break;
  }

  if (!matchedTarget) {
    res.statusCode = 401;
    res.end("unauthorized");
    return true;
  }

  matchedTarget.statusSink?.({ lastInboundAt: Date.now() });
  processGHLWebhook(payload, matchedTarget).catch((err) => {
    matchedTarget.runtime.error?.(
      `[${matchedTarget.account.accountId}] GHL webhook failed: ${String(err)}`,
    );
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end("{}");
  return true;
}

async function processGHLWebhook(payload: GHLWebhookPayload, target: WebhookTarget) {
  // Only process inbound messages
  if (payload.direction !== "inbound") {
    return;
  }

  const body = payload.body?.trim();
  const hasAttachments = (payload.attachments?.length ?? 0) > 0;
  const rawBody = body || (hasAttachments ? "<media:attachment>" : "");
  if (!rawBody) {
    return;
  }

  const contactId = payload.contactId ?? "";
  const conversationId = payload.conversationId ?? "";
  if (!contactId || !conversationId) {
    return;
  }

  await processMessageWithPipeline({
    payload,
    rawBody,
    account: target.account,
    config: target.config,
    runtime: target.runtime,
    core: target.core,
    statusSink: target.statusSink,
  });
}

async function processMessageWithPipeline(params: {
  payload: GHLWebhookPayload;
  rawBody: string;
  account: ResolvedGoHighLevelAccount;
  config: OpenClawConfig;
  runtime: GoHighLevelRuntimeEnv;
  core: GoHighLevelCoreRuntime;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, rawBody, account, config, runtime, core, statusSink } = params;

  const contactId = payload.contactId ?? "";
  const conversationId = payload.conversationId ?? "";
  const messageType = payload.messageType ?? "SMS";
  const senderPhone = payload.from ?? contactId;
  const senderName = payload.from ?? "";

  const pairing = createScopedPairingAccess({
    core,
    channel: "gohighlevel",
    accountId: account.accountId,
  });

  // GHL is always DM-like (CRM conversations are 1:1 with contacts)
  const dmPolicy = account.config.dm?.policy ?? account.config.dmPolicy ?? "open";

  if (dmPolicy === "allowlist") {
    const allowFrom = (account.config.dm?.allowFrom ?? account.config.allowFrom ?? []).map(
      (v: string | number) => String(v),
    );
    const allowed = allowFrom.includes("*") || allowFrom.includes(contactId);
    if (!allowed) {
      logVerbose(core, runtime, `blocked GHL message from ${contactId} (allowlist)`);
      return;
    }
  } else if (dmPolicy === "pairing") {
    const storeAllowFrom: string[] = await pairing.readAllowFromStore().catch(() => []);
    const allowed =
      storeAllowFrom.includes("*") ||
      storeAllowFrom.includes(contactId) ||
      storeAllowFrom.includes(senderPhone);
    if (!allowed) {
      const { code, created } = await pairing.upsertPairingRequest({
        id: contactId,
        meta: { name: senderName || undefined, phone: senderPhone },
      });
      if (created) {
        logVerbose(core, runtime, `GHL pairing request contact=${contactId}`);
        try {
          await sendGHLMessage({
            account,
            conversationId: contactId,
            message: core.channel.pairing.buildPairingReply({
              channel: "gohighlevel",
              idLine: `Your GHL contact id: ${contactId}`,
              code,
            }),
            messageType,
          });
          statusSink?.({ lastOutboundAt: Date.now() });
        } catch (err) {
          logVerbose(core, runtime, `pairing reply failed for ${contactId}: ${String(err)}`);
        }
      }
      return;
    }
  }
  // dmPolicy === "open" — allow all

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "gohighlevel",
    accountId: account.accountId,
    peer: { kind: "direct", id: contactId },
  });

  // Handle media attachments
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (payload.attachments && payload.attachments.length > 0) {
    const first = payload.attachments[0];
    if (first.url) {
      try {
        const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
        const loaded = await core.channel.media.fetchRemoteMedia({
          url: first.url,
          maxBytes,
        });
        const saved = await core.channel.media.saveMediaBuffer(
          loaded.buffer,
          loaded.contentType ?? first.contentType,
          "inbound",
          maxBytes,
          first.fileName,
        );
        mediaPath = saved.path;
        mediaType = saved.contentType;
      } catch (err) {
        runtime.error?.(`GHL attachment download failed: ${String(err)}`);
      }
    }
  }

  const fromLabel = senderName || `contact:${contactId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const bodyFormatted = core.channel.reply.formatAgentEnvelope({
    channel: `GoHighLevel (${messageType})`,
    from: fromLabel,
    timestamp: payload.dateAdded ? Date.parse(payload.dateAdded) : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: bodyFormatted,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `gohighlevel:${contactId}`,
    To: `gohighlevel:${conversationId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: contactId,
    Provider: "gohighlevel",
    Surface: "gohighlevel",
    MessageSid: payload.messageId,
    MessageSidFull: payload.messageId,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    OriginatingChannel: "gohighlevel",
    OriginatingTo: `gohighlevel:${conversationId}`,
  });

  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      runtime.error?.(`gohighlevel: failed updating session meta: ${String(err)}`);
    });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "gohighlevel",
    accountId: route.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (replyPayload) => {
        await deliverGHLReply({
          payload: replyPayload,
          account,
          contactId,
          conversationId,
          messageType,
          runtime,
          core,
          config,
          statusSink,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`[${account.accountId}] GHL ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: { onModelSelected },
  });
}

async function deliverGHLReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  account: ResolvedGoHighLevelAccount;
  contactId: string;
  conversationId: string;
  messageType: string;
  runtime: GoHighLevelRuntimeEnv;
  core: GoHighLevelCoreRuntime;
  config: OpenClawConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, account, contactId, messageType, runtime, core, config, statusSink } = params;

  if (payload.text) {
    const chunkLimit = account.config.textChunkLimit ?? 1600;
    const chunkMode = core.channel.text.resolveChunkMode(config, "gohighlevel", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);
    for (const chunk of chunks) {
      try {
        await sendGHLMessage({
          account,
          conversationId: contactId,
          message: chunk,
          messageType,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`GHL message send failed: ${String(err)}`);
      }
    }
  }
}

export function monitorGoHighLevelProvider(options: GoHighLevelMonitorOptions): () => void {
  const core = getGoHighLevelRuntime();
  const webhookPath = resolveWebhookPath({
    webhookPath: options.webhookPath,
    webhookUrl: options.webhookUrl,
    defaultPath: "/gohighlevel",
  });
  if (!webhookPath) {
    options.runtime.error?.(`[${options.account.accountId}] invalid webhook path`);
    return () => {};
  }

  const unregister = registerGoHighLevelWebhookTarget({
    account: options.account,
    config: options.config,
    runtime: options.runtime,
    core,
    path: webhookPath,
    statusSink: options.statusSink,
  });

  return unregister;
}

export async function startGoHighLevelMonitor(
  params: GoHighLevelMonitorOptions,
): Promise<() => void> {
  return monitorGoHighLevelProvider(params);
}

export function resolveGoHighLevelWebhookPath(params: {
  account: ResolvedGoHighLevelAccount;
}): string {
  return (
    resolveWebhookPath({
      webhookPath: params.account.config.webhookPath,
      webhookUrl: params.account.config.webhookUrl,
      defaultPath: "/gohighlevel",
    }) ?? "/gohighlevel"
  );
}
