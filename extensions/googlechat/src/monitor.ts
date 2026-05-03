import { createHash } from "node:crypto";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  createChannelReplyPipeline,
  resolveInboundRouteEnvelopeBuilderWithRuntime,
  resolveWebhookPath,
} from "../runtime-api.js";
import { type ResolvedGoogleChatAccount } from "./accounts.js";
import { downloadGoogleChatMedia, sendGoogleChatMessage } from "./api.js";
import { type GoogleChatAudienceType } from "./auth.js";
import { applyGoogleChatInboundAccessPolicy } from "./monitor-access.js";
import { deliverGoogleChatReply } from "./monitor-reply-delivery.js";
import {
  registerGoogleChatWebhookTarget,
  setGoogleChatWebhookEventProcessor,
} from "./monitor-routing.js";
import type {
  GoogleChatCoreRuntime,
  GoogleChatMonitorOptions,
  GoogleChatRuntimeEnv,
  WebhookTarget,
} from "./monitor-types.js";
import { warnAppPrincipalMisconfiguration } from "./monitor-webhook.js";
import { getGoogleChatRuntime } from "./runtime.js";
import type { GoogleChatAttachment, GoogleChatEvent } from "./types.js";

setGoogleChatWebhookEventProcessor(processGoogleChatEvent);

function logVerbose(core: GoogleChatCoreRuntime, runtime: GoogleChatRuntimeEnv, message: string) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[googlechat] ${message}`);
  }
}

export function resolveGoogleChatSessionKey(params: {
  baseSessionKey: string;
  threadName: string | null | undefined;
  sessionThread: boolean | undefined;
}): string {
  if (!params.sessionThread || !params.threadName) {
    return params.baseSessionKey;
  }
  // Hash the thread resource name for the session-key suffix instead of
  // embedding it raw. Google Chat thread names are case-sensitive, but session
  // store keys are canonicalized to lowercase, which would corrupt any raw
  // name extracted back via parseSessionThreadInfo and cause outbound
  // restart/update flows to target the wrong thread. A hex hash survives
  // canonicalization, and the `:gcthread:` marker keeps the generic
  // `:thread:` parser from surfacing the hash as a routable thread id — the
  // case-sensitive thread name flows through ctx.MessageThreadId instead.
  const threadHash = createHash("sha256")
    .update(params.threadName.trim())
    .digest("hex")
    .slice(0, 16);
  return `${params.baseSessionKey}:gcthread:${threadHash}`;
}

function normalizeAudienceType(value?: string | null): GoogleChatAudienceType | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "app-url" || normalized === "app_url" || normalized === "app") {
    return "app-url";
  }
  if (
    normalized === "project-number" ||
    normalized === "project_number" ||
    normalized === "project"
  ) {
    return "project-number";
  }
  return undefined;
}

async function processGoogleChatEvent(event: GoogleChatEvent, target: WebhookTarget) {
  const eventType = event.type ?? (event as { eventType?: string }).eventType;
  if (eventType !== "MESSAGE") {
    return;
  }
  if (!event.message || !event.space) {
    return;
  }

  await processMessageWithPipeline({
    event,
    account: target.account,
    config: target.config,
    runtime: target.runtime,
    core: target.core,
    statusSink: target.statusSink,
    mediaMaxMb: target.mediaMaxMb,
  });
}

/**
 * Resolve bot display name with fallback chain:
 * 1. Account config name
 * 2. Agent name from config
 * 3. "OpenClaw" as generic fallback
 */
function resolveBotDisplayName(params: {
  accountName?: string;
  agentId: string;
  config: OpenClawConfig;
}): string {
  const { accountName, agentId, config } = params;
  if (accountName?.trim()) {
    return accountName.trim();
  }
  const agent = config.agents?.list?.find((a) => a.id === agentId);
  if (agent?.name?.trim()) {
    return agent.name.trim();
  }
  return "OpenClaw";
}

async function processMessageWithPipeline(params: {
  event: GoogleChatEvent;
  account: ResolvedGoogleChatAccount;
  config: OpenClawConfig;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  mediaMaxMb: number;
}): Promise<void> {
  const { event, account, config, runtime, core, statusSink, mediaMaxMb } = params;
  const space = event.space;
  const message = event.message;
  if (!space || !message) {
    return;
  }

  const spaceId = space.name ?? "";
  if (!spaceId) {
    return;
  }
  const spaceType = (space.type ?? "").toUpperCase();
  const isGroup = spaceType !== "DM";
  const sender = message.sender ?? event.user;
  const senderId = sender?.name ?? "";
  const senderName = sender?.displayName ?? "";
  const senderEmail = sender?.email ?? undefined;

  const allowBots = account.config.allowBots === true;
  if (!allowBots) {
    if (sender?.type?.toUpperCase() === "BOT") {
      logVerbose(core, runtime, `skip bot-authored message (${senderId || "unknown"})`);
      return;
    }
    if (senderId === "users/app") {
      logVerbose(core, runtime, "skip app-authored message");
      return;
    }
  }

  const messageText = (message.argumentText ?? message.text ?? "").trim();
  const attachments = message.attachment ?? [];
  const hasMedia = attachments.length > 0;
  const rawBody = messageText || (hasMedia ? "<media:attachment>" : "");
  if (!rawBody) {
    return;
  }

  const access = await applyGoogleChatInboundAccessPolicy({
    account,
    config,
    core,
    space,
    message,
    isGroup,
    senderId,
    senderName,
    senderEmail,
    rawBody,
    statusSink,
    logVerbose: (message) => logVerbose(core, runtime, message),
  });
  if (!access.ok) {
    return;
  }
  const { commandAuthorized, effectiveWasMentioned, groupSystemPrompt } = access;

  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: config,
    channel: "googlechat",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? ("group" as const) : ("direct" as const),
      id: spaceId,
    },
    runtime: core.channel,
    sessionStore: config.session?.store,
  });
  // When sessionThread is enabled, partition the session per Chat thread via a
  // sessionKey suffix. Routing still keys on spaceId above, so existing
  // agent bindings to the space are preserved. Keep this derived, not mutated
  // onto route — route can be a shared cached instance, and mutating it would
  // bleed the first thread's suffix into later messages in the same space.
  const sessionKey = resolveGoogleChatSessionKey({
    baseSessionKey: route.sessionKey,
    threadName: message.thread?.name,
    sessionThread: account.config.sessionThread,
  });

  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (attachments.length > 0) {
    const first = attachments[0];
    const attachmentData = await downloadAttachment(first, account, mediaMaxMb, core);
    if (attachmentData) {
      mediaPath = attachmentData.path;
      mediaType = attachmentData.contentType;
    }
  }

  const fromLabel = isGroup
    ? space.displayName || `space:${spaceId}`
    : senderName || `user:${senderId}`;
  const { storePath, body } = buildEnvelope({
    channel: "Google Chat",
    from: fromLabel,
    timestamp: event.eventTime ? Date.parse(event.eventTime) : undefined,
    body: rawBody,
    // Use the thread-partitioned sessionKey so elapsed metadata doesn't leak
    // across threads in the same space when sessionThread is enabled.
    sessionKey,
  });

  const ctxPayload = core.channel.turn.buildContext({
    channel: "googlechat",
    accountId: route.accountId,
    messageId: message.name,
    messageIdFull: message.name,
    timestamp: event.eventTime ? Date.parse(event.eventTime) : undefined,
    from: `googlechat:${senderId}`,
    sender: {
      id: senderId,
      name: senderName || undefined,
      username: senderEmail,
    },
    conversation: {
      kind: isGroup ? "channel" : "direct",
      id: spaceId,
      label: fromLabel,
      routePeer: {
        kind: isGroup ? "group" : "direct",
        id: spaceId,
      },
    },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      // Use the thread-partitioned sessionKey so session storage and elapsed
      // metadata don't leak across threads in the same space when
      // sessionThread is enabled. Route matching still keys on routeSessionKey.
      dispatchSessionKey: sessionKey,
    },
    reply: {
      to: `googlechat:${spaceId}`,
      originatingTo: `googlechat:${spaceId}`,
      replyToId: message.thread?.name,
      replyToIdFull: message.thread?.name,
      // Carry the original Google Chat thread resource name (case-sensitive)
      // so outbound restart/update flows can target the real thread without
      // reparsing the lowercased store sessionKey.
      messageThreadId: message.thread?.name,
    },
    message: {
      body,
      bodyForAgent: rawBody,
      rawBody,
      commandBody: rawBody,
      envelopeFrom: fromLabel,
    },
    media:
      mediaPath || mediaType
        ? [
            {
              path: mediaPath,
              url: mediaPath,
              contentType: mediaType,
            },
          ]
        : undefined,
    supplemental: {
      groupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    },
    extra: {
      ChatType: isGroup ? "channel" : "direct",
      WasMentioned: isGroup ? effectiveWasMentioned : undefined,
      CommandAuthorized: commandAuthorized,
      GroupSubject: undefined,
      GroupSpace: isGroup ? (space.displayName ?? undefined) : undefined,
    },
  });


  // Typing indicator setup
  // Note: Reaction mode requires user OAuth, not available with service account auth.
  // If reaction is configured, we fall back to message mode with a warning.
  let typingIndicator = account.config.typingIndicator ?? "message";
  if (typingIndicator === "reaction") {
    runtime.error?.(
      `[${account.accountId}] typingIndicator="reaction" requires user OAuth (not supported with service account). Falling back to "message" mode.`,
    );
    typingIndicator = "message";
  }
  let typingMessageName: string | undefined;

  const threadForSend = message.thread?.name;

  // Start typing indicator.
  if (typingIndicator === "message") {
    try {
      const botName = resolveBotDisplayName({
        accountName: account.config.name,
        agentId: route.agentId,
        config,
      });
      const result = await sendGoogleChatMessage({
        account,
        space: spaceId,
        text: `_${botName} is typing..._`,
        thread: threadForSend,
      });
      typingMessageName = result?.messageName;
    } catch (err) {
      runtime.error?.(`Failed sending typing message: ${String(err)}`);
    }
  }

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: config,
    agentId: route.agentId,
    channel: "googlechat",
    accountId: route.accountId,
  });

  await core.channel.turn.run({
    channel: "googlechat",
    accountId: route.accountId,
    raw: message,
    adapter: {
      ingest: () => ({
        id: message.name ?? spaceId,
        timestamp: event.eventTime ? Date.parse(event.eventTime) : undefined,
        rawText: rawBody,
        textForAgent: rawBody,
        textForCommands: rawBody,
        raw: message,
      }),
      resolveTurn: () => ({
        cfg: config,
        channel: "googlechat",
        accountId: route.accountId,
        agentId: route.agentId,
        routeSessionKey: route.sessionKey,
        storePath,
        ctxPayload,
        recordInboundSession: core.channel.session.recordInboundSession,
        dispatchReplyWithBufferedBlockDispatcher:
          core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
        delivery: {
          deliver: async (payload) => {
            await deliverGoogleChatReply({
              payload,
              account,
              spaceId,
              runtime,
              core,
              config,
              statusSink,
              typingMessageName,
              forcedThreadName: threadForSend,
            });
            // Only use typing message for first delivery
            typingMessageName = undefined;
          },
          onError: (err, info) => {
            runtime.error?.(
              `[${account.accountId}] Google Chat ${info.kind} reply failed: ${String(err)}`,
            );
          },
        },
        dispatcherOptions: replyPipeline,
        replyOptions: {
          onModelSelected,
        },
        record: {
          onRecordError: (err) => {
            runtime.error?.(`googlechat: failed updating session meta: ${String(err)}`);
          },
        },
      }),
    },
  });
}

async function downloadAttachment(
  attachment: GoogleChatAttachment,
  account: ResolvedGoogleChatAccount,
  mediaMaxMb: number,
  core: GoogleChatCoreRuntime,
): Promise<{ path: string; contentType?: string } | null> {
  const resourceName = attachment.attachmentDataRef?.resourceName;
  if (!resourceName) {
    return null;
  }
  const maxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  const downloaded = await downloadGoogleChatMedia({ account, resourceName, maxBytes });
  const saved = await core.channel.media.saveMediaBuffer(
    downloaded.buffer,
    downloaded.contentType ?? attachment.contentType,
    "inbound",
    maxBytes,
    attachment.contentName,
  );
  return { path: saved.path, contentType: saved.contentType };
}

function monitorGoogleChatProvider(options: GoogleChatMonitorOptions): () => void {
  const core = getGoogleChatRuntime();
  const webhookPath = resolveWebhookPath({
    webhookPath: options.webhookPath,
    webhookUrl: options.webhookUrl,
    defaultPath: "/googlechat",
  });
  if (!webhookPath) {
    options.runtime.error?.(`[${options.account.accountId}] invalid webhook path`);
    return () => {};
  }

  const audienceType = normalizeAudienceType(options.account.config.audienceType);
  const audience = options.account.config.audience?.trim();
  const mediaMaxMb = options.account.config.mediaMaxMb ?? 20;

  warnAppPrincipalMisconfiguration({
    accountId: options.account.accountId,
    audienceType,
    appPrincipal: options.account.config.appPrincipal,
    log: options.runtime.log,
  });

  const unregisterTarget = registerGoogleChatWebhookTarget({
    account: options.account,
    config: options.config,
    runtime: options.runtime,
    core,
    path: webhookPath,
    audienceType,
    audience,
    statusSink: options.statusSink,
    mediaMaxMb,
  });

  return () => {
    unregisterTarget();
  };
}

export async function startGoogleChatMonitor(
  params: GoogleChatMonitorOptions,
): Promise<() => void> {
  return monitorGoogleChatProvider(params);
}

export function resolveGoogleChatWebhookPath(params: {
  account: ResolvedGoogleChatAccount;
}): string {
  return (
    resolveWebhookPath({
      webhookPath: params.account.config.webhookPath,
      webhookUrl: params.account.config.webhookUrl,
      defaultPath: "/googlechat",
    }) ?? "/googlechat"
  );
}
