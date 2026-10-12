import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  formatInboundMediaUnavailableText,
  recordChannelBotPairLoopAndCheckSuppression,
  createChannelInboundEnvelopeBuilderAsync,
  toInboundMediaFactsWithMetadata,
  type ChannelInboundMediaInput,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { channelBlockedPatch, channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { parseDateStringTimestampMs as resolveGoogleChatTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveWebhookPath } from "openclaw/plugin-sdk/webhook-ingress";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { downloadGoogleChatMedia, sendGoogleChatMessage } from "./api.js";
import { maybeHandleGoogleChatApprovalCardClick } from "./approval-card-click.js";
import { applyGoogleChatInboundAccessPolicy } from "./monitor-access.js";
import { resolveGoogleChatDurableReplyOptions } from "./monitor-durable.js";
import {
  createGoogleChatIngressMonitor,
  type GoogleChatIngressLifecycle,
} from "./monitor-ingress.js";
import {
  createGoogleChatTypingMessage,
  deliverGoogleChatReply,
  type GoogleChatTypingMessage,
} from "./monitor-reply-delivery.js";
import { normalizeGoogleChatReplyTarget } from "./monitor-reply-target.js";
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
import { rememberGoogleChatSpace, startGoogleChatSpaceCache } from "./space-cache.js";
import { isGoogleChatGroupSpace } from "./targets.js";
import type { GoogleChatAttachment, GoogleChatEvent } from "./types.js";

setGoogleChatWebhookEventProcessor(processGoogleChatEvent);

function logVerbose(core: GoogleChatCoreRuntime, runtime: GoogleChatRuntimeEnv, message: string) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[googlechat] ${message}`);
  }
}

function resolveBotDisplayName(params: {
  accountName?: string;
  agentId: string;
  config: OpenClawConfig;
}): string {
  const { accountName, agentId, config } = params;
  if (accountName?.trim()) {
    return accountName.trim();
  }
  const agent = resolveAgentConfig(config, agentId);
  if (agent?.name?.trim()) {
    return agent.name.trim();
  }
  return agent?.identity?.name?.trim() || "OpenClaw";
}

async function processGoogleChatEvent(
  event: GoogleChatEvent,
  target: WebhookTarget,
  turnAdoptionLifecycle?: GoogleChatIngressLifecycle,
  config: OpenClawConfig = target.config,
): Promise<void> {
  const eventType = event.type ?? event.eventType;
  if (event.space) {
    rememberGoogleChatSpace(target.account, event.space);
  }
  if (eventType === "CARD_CLICKED") {
    await maybeHandleGoogleChatApprovalCardClick({ event, target });
    return;
  }
  if (eventType !== "MESSAGE") {
    return;
  }
  const { account, runtime, core, statusSink, mediaMaxMb } = target;
  const space = event.space;
  const message = event.message;
  if (!space || !message) {
    return;
  }

  const spaceId = space.name ?? "";
  if (!spaceId) {
    return;
  }
  const isGroup = isGoogleChatGroupSpace(space);
  const sender = message.sender ?? event.user;
  const senderId = sender?.name ?? "";
  const senderName = sender?.displayName ?? "";
  const senderEmail = sender?.email ?? undefined;
  const isBotSender = sender?.type?.toUpperCase() === "BOT";
  const appUserId = account.config.botUser?.trim() || "users/app";

  const allowBots = account.config.allowBots === true;
  if (!allowBots) {
    if (isBotSender) {
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
  let rawBody = messageText;
  if (!rawBody && attachments.length === 0) {
    return;
  }

  const route = resolveAgentRoute({
    cfg: config,
    channel: "googlechat",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? ("group" as const) : ("direct" as const),
      id: spaceId,
    },
  });

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
    contextBinding: {
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      ...(message.name ? { messageId: message.name } : {}),
      inboundEventKind: "user_request",
    },
    statusSink,
    logVerbose: (messageLocal) => logVerbose(core, runtime, messageLocal),
  });
  if (!access.ok) {
    return;
  }
  const { commandAuthorized, effectiveWasMentioned, groupBotLoopProtection, groupSystemPrompt } =
    access;
  if (allowBots && isBotSender && senderId && senderId !== appUserId) {
    const botLoopResult = recordChannelBotPairLoopAndCheckSuppression({
      scopeId: account.accountId,
      conversationId: spaceId,
      senderId,
      receiverId: appUserId,
      config: mergePairLoopGuardConfig(account.config.botLoopProtection, groupBotLoopProtection),
      defaultsConfig: config.channels?.defaults?.botLoopProtection,
      defaultEnabled: true,
      nowMs: resolveGoogleChatTimestampMs(event.eventTime),
    });
    if (botLoopResult.suppressed) {
      logVerbose(core, runtime, `skip bot-to-bot loop in ${spaceId}`);
      return;
    }
  }

  const mediaInputs: ChannelInboundMediaInput[] = attachments.map((attachment) => ({
    contentType: attachment.contentType,
  }));
  const first = attachments.at(0);
  if (first) {
    try {
      const attachmentData = await downloadAttachment(first, account, mediaMaxMb, core);
      if (attachmentData) {
        mediaInputs[0] = {
          path: attachmentData.path,
          url: attachmentData.path,
          contentType: attachmentData.contentType ?? first.contentType,
        };
      } else {
        const reason = first.driveDataRef
          ? "Google Drive files are not downloadable"
          : "unsupported attachment source";
        const notice = `[Google Chat attachment unavailable: ${reason}; upload the file directly]`;
        rawBody = formatInboundMediaUnavailableText({ body: rawBody, notice });
        runtime.error?.(`[${account.accountId}] ${notice}`);
      }
    } catch (error) {
      if (!(error instanceof MediaFetchError) || error.code !== "max_bytes") {
        throw error;
      }
      // Adopt permanent size failures after authorizing the original text; retrying
      // them would block every later durable message in the same conversation.
      const notice = `[Google Chat attachment too large; maximum ${mediaMaxMb} MB]`;
      rawBody = formatInboundMediaUnavailableText({ body: rawBody, notice });
      runtime.error?.(
        `[${account.accountId}] ${notice} Increase channels.googlechat.mediaMaxMb to process larger attachments.`,
      );
    }
  }
  const additionalCount = attachments.length - 1;
  if (additionalCount > 0) {
    const notice = `[Google Chat: ${additionalCount} additional ${additionalCount === 1 ? "attachment was" : "attachments were"} not processed; only the first attachment is supported]`;
    rawBody = formatInboundMediaUnavailableText({ body: rawBody, notice });
  }
  const media = mediaInputs.length === 0 ? [] : await toInboundMediaFactsWithMetadata(mediaInputs);

  const fromLabel = isGroup
    ? space.displayName || `space:${spaceId}`
    : senderName || `user:${senderId}`;
  const timestampMs = resolveGoogleChatTimestampMs(event.eventTime);
  const buildEnvelope = await createChannelInboundEnvelopeBuilderAsync({ cfg: config, route });
  const body = buildEnvelope({
    channel: "Google Chat",
    from: fromLabel,
    timestamp: timestampMs,
    body: rawBody,
  });

  const replyThreadName = isGroup ? message.thread?.name : undefined;
  const ctxPayload = core.channel.inbound.buildContext({
    channelIngress: access.channelIngress,
    channel: "googlechat",
    accountId: route.accountId,
    messageId: message.name,
    messageIdFull: message.name,
    timestamp: timestampMs,
    from: `googlechat:${senderId}`,
    sender: {
      id: senderId,
      name: senderName || undefined,
      username: senderEmail,
      isBot: isBotSender || undefined,
    },
    conversation: {
      kind: isGroup ? "channel" : "direct",
      id: spaceId,
      label: fromLabel,
    },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
    },
    reply: {
      to: `googlechat:${spaceId}`,
      originatingTo: `googlechat:${spaceId}`,
      replyToId: replyThreadName,
      replyToIdFull: replyThreadName,
    },
    message: {
      body,
      bodyForAgent: rawBody,
      rawBody,
      commandBody: rawBody,
    },
    media: media.length > 0 ? media : undefined,
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

  let typingIndicator = account.config.typingIndicator ?? "message";
  if (typingIndicator === "reaction") {
    runtime.error?.(
      `[${account.accountId}] typingIndicator="reaction" requires user OAuth (not supported with service account). Falling back to "message" mode.`,
    );
    typingIndicator = "message";
  }
  let typingMessage: GoogleChatTypingMessage | undefined;
  const effectiveReplyThreadName =
    account.config.replyToMode && account.config.replyToMode !== "off"
      ? replyThreadName
      : undefined;

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
        thread: effectiveReplyThreadName,
      });
      if (result?.messageName) {
        typingMessage = createGoogleChatTypingMessage({
          messageName: result.messageName,
          requestedThreadName: effectiveReplyThreadName,
          deliveredThreadName: result.threadName,
        });
      }
    } catch (err) {
      runtime.error?.(`Failed sending typing message: ${String(err)}`);
    }
  }

  await core.channel.inbound.run({
    channel: "googlechat",
    accountId: route.accountId,
    raw: message,
    ...(turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {}),
    adapter: {
      ingest: () => ({
        id: message.name ?? spaceId,
        timestamp: timestampMs,
        rawText: rawBody,
        textForAgent: rawBody,
        textForCommands: rawBody,
        raw: message,
      }),
      resolveTurn: () => ({
        cfg: config,
        channel: "googlechat",
        accountId: route.accountId,
        route: { agentId: route.agentId, sessionKey: route.sessionKey },
        ctxPayload,
        delivery: {
          durable: (payload, info) =>
            resolveGoogleChatDurableReplyOptions({
              payload: normalizeGoogleChatReplyTarget({
                payload,
                sourceMessageName: message.name,
                replyThreadName: effectiveReplyThreadName,
              }),
              infoKind: info.kind,
              spaceId,
              hasTypingMessage: Boolean(typingMessage),
            }),
          deliver: async (payload) => {
            await deliverGoogleChatReply({
              payload: normalizeGoogleChatReplyTarget({
                payload,
                sourceMessageName: message.name,
                replyThreadName: effectiveReplyThreadName,
              }),
              account,
              spaceId,
              runtime,
              core,
              config,
              statusSink,
              typingMessage,
            });
            // Only use typing message for first delivery
            typingMessage = undefined;
          },
          onDelivered: () => {
            statusSink?.({ lastOutboundAt: Date.now() });
          },
          onError: (err, info) => {
            runtime.error?.(
              `[${account.accountId}] Google Chat ${info.kind} reply failed: ${String(err)}`,
            );
          },
        },
        replyPipeline: {},
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

export async function startGoogleChatMonitor(
  options: GoogleChatMonitorOptions,
): Promise<() => Promise<void>> {
  const core = getGoogleChatRuntime();
  const webhookPath = resolveGoogleChatWebhookPath(options);
  if (!webhookPath) {
    options.runtime.error?.(`[${options.account.accountId}] invalid webhook path`);
    return async () => {};
  }

  const audienceType = options.account.config.audienceType;
  const audience = options.account.config.audience?.trim();
  if ((audienceType !== "app-url" && audienceType !== "project-number") || !audience) {
    const error =
      "Google Chat webhook authentication requires channels.googlechat.audienceType and channels.googlechat.audience.";
    options.runtime.error?.(`[${options.account.accountId}] ${error}`);
    options.statusSink?.(
      channelBlockedPatch(error, {
        running: true,
        connected: false,
        webhookPath: undefined,
      }),
    );
    return async () => {};
  }
  const mediaMaxMb = options.account.config.mediaMaxMb ?? 20;

  warnAppPrincipalMisconfiguration({
    accountId: options.account.accountId,
    audienceType,
    appPrincipal: options.account.config.appPrincipal,
    log: options.runtime.log,
  });

  const readConfig = createRuntimeConfigReader(options.config);
  const stopSpaceCache = startGoogleChatSpaceCache(options.account);
  const ingress = createGoogleChatIngressMonitor({
    accountId: options.account.accountId,
    runtime: options.runtime,
    abortSignal: options.abortSignal,
    dispatch: async (event, lifecycle) => {
      await processGoogleChatEvent(event, target, lifecycle, readConfig());
    },
  });
  const target: WebhookTarget = {
    account: options.account,
    config: options.config,
    runtime: options.runtime,
    core,
    path: webhookPath,
    audienceType,
    audience,
    statusSink: options.statusSink,
    mediaMaxMb,
    ingress,
  };
  ingress.start();
  let unregisterTarget: (() => void) | undefined;
  try {
    unregisterTarget = registerGoogleChatWebhookTarget(target);
    options.statusSink?.(channelReadyPatch());
  } catch (error) {
    try {
      await ingress.stop();
    } finally {
      stopSpaceCache();
    }
    throw error;
  }

  return async () => {
    unregisterTarget?.();
    try {
      await ingress.stop();
    } finally {
      stopSpaceCache();
    }
  };
}

// Invalid webhook URLs stay null so status never advertises an unbound default route.
export function resolveGoogleChatWebhookPath({
  webhookPath,
  webhookUrl,
}: Pick<GoogleChatMonitorOptions, "webhookPath" | "webhookUrl">): string | null {
  return resolveWebhookPath({
    webhookPath,
    webhookUrl,
    defaultPath: "/googlechat",
  });
}
