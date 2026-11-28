import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  createChannelPartialDeliveryError,
  formatInboundMediaUnavailableText,
  recordChannelBotPairLoopAndCheckSuppression,
  createChannelInboundEnvelopeBuilderAsync,
  toInboundMediaFactsWithMetadata,
  type ChannelInboundMediaInput,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { channelBlockedPatch, channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { parseDateStringTimestampMs as resolveGoogleChatTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveWebhookPath } from "openclaw/plugin-sdk/webhook-ingress";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import {
  deleteGoogleChatMessage,
  downloadGoogleChatMedia,
  GoogleChatApiError,
  sendGoogleChatMessage,
  updateGoogleChatMessage,
} from "./api.js";
import { maybeHandleGoogleChatApprovalCardClick } from "./approval-card-click.js";
import { formatGoogleChatMediaText, formatGoogleChatTextChunks } from "./format.js";
import { applyGoogleChatInboundAccessPolicy } from "./monitor-access.js";
import {
  createGoogleChatIngressMonitor,
  type GoogleChatIngressLifecycle,
} from "./monitor-ingress.js";
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
import { isGoogleChatGroupSpace } from "./targets.js";
import type { GoogleChatAttachment, GoogleChatEvent } from "./types.js";

setGoogleChatWebhookEventProcessor(processGoogleChatEvent);

type GoogleChatTypingMessage = ReturnType<typeof createGoogleChatTypingMessage>;

function createGoogleChatTypingMessage(params: {
  messageName: string;
  requestedThreadName?: string;
  deliveredThreadName?: string;
}) {
  const name = params.messageName.trim();
  const requestedThreadName = params.requestedThreadName?.trim();
  if (!requestedThreadName) {
    return { placement: "top-level" as const, name };
  }
  return {
    placement: "thread" as const,
    name,
    requestedThreadName,
    deliveredThreadName: params.deliveredThreadName?.trim() || requestedThreadName,
  };
}

function logVerbose(core: GoogleChatCoreRuntime, runtime: GoogleChatRuntimeEnv, message: string) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[googlechat] ${message}`);
  }
}

async function processGoogleChatEvent(
  event: GoogleChatEvent,
  target: WebhookTarget,
  turnAdoptionLifecycle?: GoogleChatIngressLifecycle,
  config: OpenClawConfig = target.config,
): Promise<void> {
  const eventType = event.type ?? event.eventType;
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
  const senderEmail = sender?.email;
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
  const attachmentNotices = new Set<string>();
  const reportAttachmentUnavailable = (notice: string, hint = "") => {
    if (attachmentNotices.has(notice)) {
      return;
    }
    attachmentNotices.add(notice);
    rawBody = formatInboundMediaUnavailableText({ body: rawBody, notice });
    runtime.error?.(`[${account.accountId}] ${notice}${hint}`);
  };
  for (const [index, attachment] of attachments.entries()) {
    try {
      const attachmentData = await downloadAttachment(attachment, account, mediaMaxMb, core);
      if (attachmentData) {
        mediaInputs[index] = {
          path: attachmentData.path,
          url: attachmentData.path,
          contentType: attachmentData.contentType ?? attachment.contentType,
        };
      } else {
        const reason = attachment.driveDataRef
          ? "Google Drive files are not downloadable"
          : "unsupported attachment source";
        const notice = `[Google Chat attachment unavailable: ${reason}; upload the file directly]`;
        reportAttachmentUnavailable(notice);
      }
    } catch (error) {
      const missing = error instanceof GoogleChatApiError && error.status === 404;
      if (!missing && (!(error instanceof MediaFetchError) || error.code !== "max_bytes")) {
        throw error;
      }
      // Adopt permanent attachment failures after authorizing the original text; retrying
      // them would block every later durable message in the same conversation.
      const notice = missing
        ? "[Google Chat attachment unavailable: file not found; upload the file directly]"
        : `[Google Chat attachment too large; maximum ${mediaMaxMb} MB]`;
      reportAttachmentUnavailable(
        notice,
        missing ? "" : " Increase channels.googlechat.mediaMaxMb to process larger attachments.",
      );
    }
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
      GroupSpace: isGroup ? space.displayName : undefined,
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
      const accountName = account.config.name;
      const agentId = route.agentId;
      let botName: string;
      if (accountName?.trim()) {
        botName = accountName.trim();
      } else {
        const agent = resolveAgentConfig(config, agentId);
        botName = agent?.name?.trim()
          ? agent.name.trim()
          : agent?.identity?.name?.trim() || "OpenClaw";
      }
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

  const cleanupTypingMessage = async () => {
    const placeholder = typingMessage;
    typingMessage = undefined;
    if (!placeholder) {
      return;
    }
    try {
      await deleteGoogleChatMessage({ account, messageName: placeholder.name });
    } catch (error) {
      runtime.error?.(`Google Chat typing cleanup failed: ${String(error)}`);
    }
  };
  let deferred = false;
  const typingTurnLifecycle: Parameters<
    GoogleChatCoreRuntime["channel"]["inbound"]["run"]
  >[0]["turnAdoptionLifecycle"] = typingMessage
    ? {
        ...turnAdoptionLifecycle,
        onAdopted: () => turnAdoptionLifecycle?.onAdopted(),
        onDeferred: () => {
          turnAdoptionLifecycle?.onDeferred();
          deferred = true;
        },
        // Immediate agent settlement precedes buffered final delivery.
        onSettled: () => (deferred ? cleanupTypingMessage() : undefined),
      }
    : turnAdoptionLifecycle;

  try {
    await core.channel.inbound.run({
      channel: "googlechat",
      accountId: route.accountId,
      raw: message,
      ...(typingTurnLifecycle ? { turnAdoptionLifecycle: typingTurnLifecycle } : {}),
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
            durable: (payload, info) => {
              const normalizedPayload = normalizeGoogleChatReplyTarget({
                payload,
                sourceMessageName: message.name,
                replyThreadName: effectiveReplyThreadName,
              });
              if (info.kind !== "final" || Boolean(typingMessage)) {
                return false;
              }
              const threadId = normalizedPayload.replyToId?.trim() || undefined;
              if (!threadId) {
                return { to: spaceId, replyToId: null };
              }
              return {
                to: spaceId,
                replyToId: threadId,
                threadId,
              };
            },
            deliver: async (payload) => {
              const normalizedPayload = normalizeGoogleChatReplyTarget({
                payload,
                sourceMessageName: message.name,
                replyThreadName: effectiveReplyThreadName,
              });
              // Clear this whenever the typing message is deleted or unavailable; otherwise
              // text delivery can keep retrying a dead message and drop content.
              let deliveryTypingMessage = typingMessage;
              const targetThreadName = normalizedPayload.replyToId?.trim() || undefined;
              const reply = resolveSendableOutboundReplyParts(normalizedPayload);
              let deliveryThreadName = targetThreadName;
              const acceptedText: Array<{ id?: string; text: string }> = [];
              const runTextOperation = async <T>(operation: Promise<T>): Promise<T> =>
                await operation.catch((error: unknown) => {
                  if (acceptedText.length === 0) {
                    throw error;
                  }
                  throw createChannelPartialDeliveryError(error, {
                    messageIds: acceptedText.flatMap(({ id }) => (id ? [id] : [])),
                    content: acceptedText.map(({ text }) => text).join("\n"),
                    visibleReplySent: true,
                  });
                });

              const typingMatchesReply =
                deliveryTypingMessage?.placement === "thread"
                  ? deliveryTypingMessage.requestedThreadName === targetThreadName
                  : deliveryTypingMessage?.placement === "top-level"
                    ? targetThreadName === undefined
                    : false;
              if (deliveryTypingMessage && !typingMatchesReply) {
                // Typing starts before reply directives are resolved. Never edit a placeholder
                // from one thread into a final reply targeted at another conversation surface.
                await cleanupTypingMessage();
                deliveryTypingMessage = undefined;
              } else if (deliveryTypingMessage?.placement === "thread") {
                // The requested thread decides whether the placeholder still belongs to this reply;
                // the provider-returned thread owns every later physical send after fallback.
                deliveryThreadName = deliveryTypingMessage.deliveredThreadName;
              }

              let text: string;
              try {
                text = formatGoogleChatMediaText(reply.text, reply.mediaUrls);
              } catch (cause) {
                await cleanupTypingMessage();
                throw new PlatformMessageNotDispatchedError(
                  cause instanceof Error ? cause.message : String(cause),
                  { cause, retryable: false },
                );
              }

              const chunkLimit = account.config.textChunkLimit ?? 4000;
              const chunkMode = core.channel.text.resolveChunkMode(
                config,
                "googlechat",
                account.accountId,
              );
              const chunks = formatGoogleChatTextChunks(text, chunkLimit).flatMap((chunk) =>
                core.channel.text.chunkMarkdownTextWithMode(chunk, chunkLimit, chunkMode),
              );
              const rejection =
                text && !chunks.some((chunk) => chunk)
                  ? "Google Chat reply has no visible text after formatting."
                  : undefined;
              if (rejection) {
                await cleanupTypingMessage();
                // Permanent policy rejection before any recipient-visible send; the typed
                // contract keeps delivery custody from recording a false ambiguous attempt.
                throw new PlatformMessageNotDispatchedError(rejection, {
                  cause: undefined,
                  retryable: false,
                });
              }

              const recordOutboundStatus = () => {
                try {
                  statusSink?.({ lastOutboundAt: Date.now() });
                } catch (err) {
                  runtime.error?.(`Google Chat outbound status update failed: ${String(err)}`);
                }
              };
              const sendTextMessage = async (chunk: string) => {
                const sent = await runTextOperation(
                  sendGoogleChatMessage({
                    account,
                    space: spaceId,
                    text: chunk,
                    thread: deliveryThreadName,
                  }),
                );
                if (sent) {
                  acceptedText.push({ id: sent.messageName?.trim() || undefined, text: chunk });
                }
                if (targetThreadName) {
                  deliveryThreadName = sent?.threadName?.trim() || deliveryThreadName;
                }
              };
              for (const chunk of chunks) {
                if (!chunk) {
                  continue;
                }
                if (deliveryTypingMessage) {
                  // PATCH can apply before its response fails. Cleanup must never delete a possible answer.
                  typingMessage = undefined;
                  try {
                    const updated = await updateGoogleChatMessage({
                      account,
                      messageName: deliveryTypingMessage.name,
                      text: chunk,
                    });
                    acceptedText.push({
                      id: updated.messageName?.trim() || deliveryTypingMessage.name,
                      text: chunk,
                    });
                  } catch (error) {
                    if (!(error instanceof GoogleChatApiError) || error.status !== 404) {
                      throw error;
                    }
                    runtime.error?.(`Google Chat typing update failed: ${String(error)}`);
                    await sendTextMessage(chunk);
                  }
                  deliveryTypingMessage = undefined;
                  recordOutboundStatus();
                  continue;
                }
                await sendTextMessage(chunk);
                recordOutboundStatus();
              }
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
  } finally {
    if (!deferred) {
      await cleanupTypingMessage();
    }
  }
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
  const maxBytes = mediaMaxMb * 1024 * 1024;
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
    await ingress.stop();
    throw error;
  }

  return async () => {
    unregisterTarget?.();
    await ingress.stop();
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
