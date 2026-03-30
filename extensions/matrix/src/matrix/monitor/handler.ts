import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  ensureConfiguredAcpBindingReady,
  formatAllowlistMatchMeta,
  getAgentScopedMediaLocalRoots,
  getSessionBindingService,
  logInboundDrop,
  logTypingFailure,
  resolveControlCommandGate,
  type PluginRuntime,
  type ReplyPayload,
  type RuntimeEnv,
  type RuntimeLogger,
} from "../../runtime-api.js";
import type { CoreConfig, MatrixRoomConfig, ReplyToMode } from "../../types.js";
import { createMatrixDraftStream } from "../draft-stream.js";
import {
  formatMatrixMediaUnavailableText,
  formatMatrixMessageText,
  resolveMatrixMessageAttachment,
  resolveMatrixMessageBody,
} from "../media-text.js";
import { fetchMatrixPollSnapshot } from "../poll-summary.js";
import {
  formatPollAsText,
  isPollEventType,
  isPollStartType,
  parsePollStartContent,
} from "../poll-types.js";
import type { LocationMessageEventContent, MatrixClient } from "../sdk.js";
import {
  editMessageMatrix,
  reactMatrixMessage,
  sendMessageMatrix,
  sendReadReceiptMatrix,
  sendTypingMatrix,
} from "../send.js";
import { resolveMatrixMonitorAccessState } from "./access-state.js";
import { resolveMatrixAckReactionConfig } from "./ack-config.js";
import type { MatrixInboundEventDeduper } from "./inbound-dedupe.js";
import { resolveMatrixLocation, type MatrixLocationPayload } from "./location.js";
import { downloadMatrixMedia } from "./media.js";
import { resolveMentions } from "./mentions.js";
import { handleInboundMatrixReaction } from "./reaction-events.js";
import { deliverMatrixReplies } from "./replies.js";
import { createMatrixReplyContextResolver } from "./reply-context.js";
import { createRoomHistoryTracker } from "./room-history.js";
import type { HistoryEntry } from "./room-history.js";
import { resolveMatrixRoomConfig } from "./rooms.js";
import { resolveMatrixInboundRoute } from "./route.js";
import { createMatrixThreadContextResolver } from "./thread-context.js";
import { resolveMatrixThreadRootId, resolveMatrixThreadTarget } from "./threads.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";
import { EventType, RelationType } from "./types.js";
import { isMatrixVerificationRoomMessage } from "./verification-utils.js";

const ALLOW_FROM_STORE_CACHE_TTL_MS = 30_000;
const PAIRING_REPLY_COOLDOWN_MS = 5 * 60_000;
const MAX_TRACKED_PAIRING_REPLY_SENDERS = 512;
type MatrixAllowBotsMode = "off" | "mentions" | "all";

export type MatrixMonitorHandlerParams = {
  client: MatrixClient;
  core: PluginRuntime;
  cfg: CoreConfig;
  accountId: string;
  runtime: RuntimeEnv;
  logger: RuntimeLogger;
  logVerboseMessage: (message: string) => void;
  allowFrom: string[];
  groupAllowFrom?: string[];
  roomsConfig?: Record<string, MatrixRoomConfig>;
  accountAllowBots?: boolean | "mentions";
  configuredBotUserIds?: ReadonlySet<string>;
  groupPolicy: "open" | "allowlist" | "disabled";
  replyToMode: ReplyToMode;
  threadReplies: "off" | "inbound" | "always";
  streaming: "partial" | "off";
  dmEnabled: boolean;
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  textLimit: number;
  mediaMaxBytes: number;
  historyLimit: number;
  startupMs: number;
  startupGraceMs: number;
  dropPreStartupMessages: boolean;
  inboundDeduper?: Pick<MatrixInboundEventDeduper, "claimEvent" | "commitEvent" | "releaseEvent">;
  directTracker: {
    isDirectMessage: (params: {
      roomId: string;
      senderId: string;
      selfUserId: string;
    }) => Promise<boolean>;
  };
  getRoomInfo: (
    roomId: string,
    opts?: { includeAliases?: boolean },
  ) => Promise<{ name?: string; canonicalAlias?: string; altAliases: string[] }>;
  getMemberDisplayName: (roomId: string, userId: string) => Promise<string>;
  needsRoomAliasesForConfig: boolean;
};

function resolveMatrixMentionPrecheckText(params: {
  eventType: string;
  content: RoomMessageEventContent;
  locationText?: string | null;
}): string {
  if (params.locationText?.trim()) {
    return params.locationText.trim();
  }
  if (typeof params.content.body === "string" && params.content.body.trim()) {
    return params.content.body.trim();
  }
  if (isPollStartType(params.eventType)) {
    const parsed = parsePollStartContent(params.content as never);
    if (parsed) {
      return formatPollAsText(parsed);
    }
  }
  return "";
}

function resolveMatrixInboundBodyText(params: {
  rawBody: string;
  filename?: string;
  mediaPlaceholder?: string;
  msgtype?: string;
  hadMediaUrl: boolean;
  mediaDownloadFailed: boolean;
}): string {
  if (params.mediaPlaceholder) {
    return params.rawBody || params.mediaPlaceholder;
  }
  if (!params.mediaDownloadFailed || !params.hadMediaUrl) {
    return params.rawBody;
  }
  return formatMatrixMediaUnavailableText({
    body: params.rawBody,
    filename: params.filename,
    msgtype: params.msgtype,
  });
}

function resolveMatrixPendingHistoryText(params: {
  mentionPrecheckText: string;
  content: RoomMessageEventContent;
  mediaUrl?: string;
}): string {
  if (params.mentionPrecheckText) {
    return params.mentionPrecheckText;
  }
  if (!params.mediaUrl) {
    return "";
  }
  const body = typeof params.content.body === "string" ? params.content.body.trim() : undefined;
  const filename =
    typeof params.content.filename === "string" ? params.content.filename.trim() : undefined;
  const msgtype = typeof params.content.msgtype === "string" ? params.content.msgtype : undefined;
  return (
    formatMatrixMessageText({
      body: resolveMatrixMessageBody({ body, filename, msgtype }),
      attachment: resolveMatrixMessageAttachment({ body, filename, msgtype }),
    }) ?? ""
  );
}

function resolveMatrixAllowBotsMode(value?: boolean | "mentions"): MatrixAllowBotsMode {
  if (value === true) {
    return "all";
  }
  if (value === "mentions") {
    return "mentions";
  }
  return "off";
}

export function createMatrixRoomMessageHandler(params: MatrixMonitorHandlerParams) {
  const {
    client,
    core,
    cfg,
    accountId,
    runtime,
    logger,
    logVerboseMessage,
    allowFrom,
    groupAllowFrom = [],
    roomsConfig,
    accountAllowBots,
    configuredBotUserIds = new Set<string>(),
    groupPolicy,
    replyToMode,
    threadReplies,
    streaming,
    dmEnabled,
    dmPolicy,
    textLimit,
    mediaMaxBytes,
    historyLimit,
    startupMs,
    startupGraceMs,
    dropPreStartupMessages,
    inboundDeduper,
    directTracker,
    getRoomInfo,
    getMemberDisplayName,
    needsRoomAliasesForConfig,
  } = params;
  let cachedStoreAllowFrom: {
    value: string[];
    expiresAtMs: number;
  } | null = null;
  const pairingReplySentAtMsBySender = new Map<string, number>();
  const resolveThreadContext = createMatrixThreadContextResolver({
    client,
    getMemberDisplayName,
    logVerboseMessage,
  });
  const resolveReplyContext = createMatrixReplyContextResolver({
    client,
    getMemberDisplayName,
    logVerboseMessage,
  });
  const roomHistoryTracker = createRoomHistoryTracker();
  const roomIngressTails = new Map<string, Promise<void>>();

  const readStoreAllowFrom = async (): Promise<string[]> => {
    const now = Date.now();
    if (cachedStoreAllowFrom && now < cachedStoreAllowFrom.expiresAtMs) {
      return cachedStoreAllowFrom.value;
    }
    const value = await core.channel.pairing
      .readAllowFromStore({
        channel: "matrix",
        env: process.env,
        accountId,
      })
      .catch(() => []);
    cachedStoreAllowFrom = {
      value,
      expiresAtMs: now + ALLOW_FROM_STORE_CACHE_TTL_MS,
    };
    return value;
  };

  const shouldSendPairingReply = (senderId: string, created: boolean): boolean => {
    const now = Date.now();
    if (created) {
      pairingReplySentAtMsBySender.set(senderId, now);
      return true;
    }
    const lastSentAtMs = pairingReplySentAtMsBySender.get(senderId);
    if (typeof lastSentAtMs === "number" && now - lastSentAtMs < PAIRING_REPLY_COOLDOWN_MS) {
      return false;
    }
    pairingReplySentAtMsBySender.set(senderId, now);
    if (pairingReplySentAtMsBySender.size > MAX_TRACKED_PAIRING_REPLY_SENDERS) {
      const oldestSender = pairingReplySentAtMsBySender.keys().next().value;
      if (typeof oldestSender === "string") {
        pairingReplySentAtMsBySender.delete(oldestSender);
      }
    }
    return true;
  };

  const runRoomIngress = async <T>(roomId: string, task: () => Promise<T>): Promise<T> => {
    const previous = roomIngressTails.get(roomId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const chain = previous.catch(() => {}).then(() => current);
    roomIngressTails.set(roomId, chain);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      releaseCurrent();
      if (roomIngressTails.get(roomId) === chain) {
        roomIngressTails.delete(roomId);
      }
    }
  };

  return async (roomId: string, event: MatrixRawEvent) => {
    const eventId = typeof event.event_id === "string" ? event.event_id.trim() : "";
    let claimedInboundEvent = false;
    let draftStreamRef: ReturnType<typeof createMatrixDraftStream> | undefined;
    try {
      const eventType = event.type;
      if (eventType === EventType.RoomMessageEncrypted) {
        // Encrypted payloads are emitted separately after decryption.
        return;
      }

      const isPollEvent = isPollEventType(eventType);
      const isReactionEvent = eventType === EventType.Reaction;
      const locationContent = event.content as LocationMessageEventContent;
      const isLocationEvent =
        eventType === EventType.Location ||
        (eventType === EventType.RoomMessage && locationContent.msgtype === EventType.Location);
      if (
        eventType !== EventType.RoomMessage &&
        !isPollEvent &&
        !isLocationEvent &&
        !isReactionEvent
      ) {
        return;
      }
      logVerboseMessage(
        `matrix: inbound event room=${roomId} type=${eventType} id=${event.event_id ?? "unknown"}`,
      );
      if (event.unsigned?.redacted_because) {
        return;
      }
      const senderId = event.sender;
      if (!senderId) {
        return;
      }
      const eventTs = event.origin_server_ts;
      const eventAge = event.unsigned?.age;
      const commitInboundEventIfClaimed = async () => {
        if (!claimedInboundEvent || !inboundDeduper || !eventId) {
          return;
        }
        await inboundDeduper.commitEvent({ roomId, eventId });
        claimedInboundEvent = false;
      };
      const ingressResult = await runRoomIngress(roomId, async () => {
        const selfUserId = await client.getUserId();
        if (senderId === selfUserId) {
          return;
        }
        if (dropPreStartupMessages) {
          if (typeof eventTs === "number" && eventTs < startupMs - startupGraceMs) {
            return;
          }
          if (
            typeof eventTs !== "number" &&
            typeof eventAge === "number" &&
            eventAge > startupGraceMs
          ) {
            return;
          }
        }

        let content = event.content as RoomMessageEventContent;

        if (
          eventType === EventType.RoomMessage &&
          isMatrixVerificationRoomMessage({
            msgtype: (content as { msgtype?: unknown }).msgtype,
            body: content.body,
          })
        ) {
          logVerboseMessage(`matrix: skip verification/system room message room=${roomId}`);
          return;
        }

        const locationPayload: MatrixLocationPayload | null = resolveMatrixLocation({
          eventType,
          content: content as LocationMessageEventContent,
        });

        const relates = content["m.relates_to"];
        if (relates && "rel_type" in relates && relates.rel_type === RelationType.Replace) {
          return;
        }
        if (eventId && inboundDeduper) {
          claimedInboundEvent = inboundDeduper.claimEvent({ roomId, eventId });
          if (!claimedInboundEvent) {
            logVerboseMessage(`matrix: skip duplicate inbound event room=${roomId} id=${eventId}`);
            return;
          }
        }

        const isDirectMessage = await directTracker.isDirectMessage({
          roomId,
          senderId,
          selfUserId,
        });
        const isRoom = !isDirectMessage;

        if (isRoom && groupPolicy === "disabled") {
          await commitInboundEventIfClaimed();
          return;
        }

        const roomInfoForConfig =
          isRoom && needsRoomAliasesForConfig
            ? await getRoomInfo(roomId, { includeAliases: true })
            : undefined;
        const roomAliasesForConfig = roomInfoForConfig
          ? [roomInfoForConfig.canonicalAlias ?? "", ...roomInfoForConfig.altAliases].filter(
              Boolean,
            )
          : [];
        const roomConfigInfo = isRoom
          ? resolveMatrixRoomConfig({
              rooms: roomsConfig,
              roomId,
              aliases: roomAliasesForConfig,
            })
          : undefined;
        const roomConfig = roomConfigInfo?.config;
        const allowBotsMode = resolveMatrixAllowBotsMode(roomConfig?.allowBots ?? accountAllowBots);
        const isConfiguredBotSender = configuredBotUserIds.has(senderId);
        const roomMatchMeta = roomConfigInfo
          ? `matchKey=${roomConfigInfo.matchKey ?? "none"} matchSource=${
              roomConfigInfo.matchSource ?? "none"
            }`
          : "matchKey=none matchSource=none";

        if (isConfiguredBotSender && allowBotsMode === "off") {
          logVerboseMessage(
            `matrix: drop configured bot sender=${senderId} (allowBots=false${isDirectMessage ? "" : `, ${roomMatchMeta}`})`,
          );
          await commitInboundEventIfClaimed();
          return;
        }

        if (isRoom && roomConfig && !roomConfigInfo?.allowed) {
          logVerboseMessage(`matrix: room disabled room=${roomId} (${roomMatchMeta})`);
          await commitInboundEventIfClaimed();
          return;
        }
        if (isRoom && groupPolicy === "allowlist") {
          if (!roomConfigInfo?.allowlistConfigured) {
            logVerboseMessage(`matrix: drop room message (no allowlist, ${roomMatchMeta})`);
            await commitInboundEventIfClaimed();
            return;
          }
          if (!roomConfig) {
            logVerboseMessage(`matrix: drop room message (not in allowlist, ${roomMatchMeta})`);
            await commitInboundEventIfClaimed();
            return;
          }
        }

        let senderNamePromise: Promise<string> | null = null;
        const getSenderName = async (): Promise<string> => {
          senderNamePromise ??= getMemberDisplayName(roomId, senderId).catch(() => senderId);
          return await senderNamePromise;
        };
        const storeAllowFrom = await readStoreAllowFrom();
        const roomUsers = roomConfig?.users ?? [];
        const accessState = resolveMatrixMonitorAccessState({
          allowFrom,
          storeAllowFrom,
          groupAllowFrom,
          roomUsers,
          senderId,
          isRoom,
        });
        const {
          effectiveRoomUsers,
          groupAllowConfigured,
          directAllowMatch,
          roomUserMatch,
          groupAllowMatch,
          commandAuthorizers,
        } = accessState;

        if (isDirectMessage) {
          if (!dmEnabled || dmPolicy === "disabled") {
            await commitInboundEventIfClaimed();
            return;
          }
          if (dmPolicy !== "open") {
            const allowMatchMeta = formatAllowlistMatchMeta(directAllowMatch);
            if (!directAllowMatch.allowed) {
              if (!isReactionEvent && dmPolicy === "pairing") {
                const senderName = await getSenderName();
                const { code, created } = await core.channel.pairing.upsertPairingRequest({
                  channel: "matrix",
                  id: senderId,
                  accountId,
                  meta: { name: senderName },
                });
                if (shouldSendPairingReply(senderId, created)) {
                  const pairingReply = core.channel.pairing.buildPairingReply({
                    channel: "matrix",
                    idLine: `Your Matrix user id: ${senderId}`,
                    code,
                  });
                  logVerboseMessage(
                    created
                      ? `matrix pairing request sender=${senderId} name=${senderName ?? "unknown"} (${allowMatchMeta})`
                      : `matrix pairing reminder sender=${senderId} name=${senderName ?? "unknown"} (${allowMatchMeta})`,
                  );
                  try {
                    await sendMessageMatrix(
                      `room:${roomId}`,
                      created
                        ? pairingReply
                        : `${pairingReply}\n\nPairing request is still pending approval. Reusing existing code.`,
                      {
                        client,
                        cfg,
                        accountId,
                      },
                    );
                    await commitInboundEventIfClaimed();
                  } catch (err) {
                    logVerboseMessage(
                      `matrix pairing reply failed for ${senderId}: ${String(err)}`,
                    );
                    return;
                  }
                } else {
                  logVerboseMessage(
                    `matrix pairing reminder suppressed sender=${senderId} (cooldown)`,
                  );
                  await commitInboundEventIfClaimed();
                }
              }
              if (isReactionEvent || dmPolicy !== "pairing") {
                logVerboseMessage(
                  `matrix: blocked ${isReactionEvent ? "reaction" : "dm"} sender ${senderId} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
                );
                await commitInboundEventIfClaimed();
              }
              return;
            }
          }
        }

        if (isRoom && roomUserMatch && !roomUserMatch.allowed) {
          logVerboseMessage(
            `matrix: blocked sender ${senderId} (room users allowlist, ${roomMatchMeta}, ${formatAllowlistMatchMeta(
              roomUserMatch,
            )})`,
          );
          await commitInboundEventIfClaimed();
          return;
        }
        if (
          isRoom &&
          groupPolicy === "allowlist" &&
          effectiveRoomUsers.length === 0 &&
          groupAllowConfigured &&
          groupAllowMatch &&
          !groupAllowMatch.allowed
        ) {
          logVerboseMessage(
            `matrix: blocked sender ${senderId} (groupAllowFrom, ${roomMatchMeta}, ${formatAllowlistMatchMeta(
              groupAllowMatch,
            )})`,
          );
          await commitInboundEventIfClaimed();
          return;
        }
        if (isRoom) {
          logVerboseMessage(`matrix: allow room ${roomId} (${roomMatchMeta})`);
        }

        if (isReactionEvent) {
          const senderName = await getSenderName();
          await handleInboundMatrixReaction({
            client,
            core,
            cfg,
            accountId,
            roomId,
            event,
            senderId,
            senderLabel: senderName,
            selfUserId,
            isDirectMessage,
            logVerboseMessage,
          });
          await commitInboundEventIfClaimed();
          return;
        }

        const mentionPrecheckText = resolveMatrixMentionPrecheckText({
          eventType,
          content,
          locationText: locationPayload?.text,
        });
        const contentUrl =
          "url" in content && typeof content.url === "string" ? content.url : undefined;
        const contentFile =
          "file" in content && content.file && typeof content.file === "object"
            ? content.file
            : undefined;
        const mediaUrl = contentUrl ?? contentFile?.url;
        const pendingHistoryText = resolveMatrixPendingHistoryText({
          mentionPrecheckText,
          content,
          mediaUrl,
        });
        if (!mentionPrecheckText && !mediaUrl && !isPollEvent) {
          await commitInboundEventIfClaimed();
          return;
        }

        const _messageId = event.event_id ?? "";
        const _threadRootId = resolveMatrixThreadRootId({ event, content });
        const {
          route: _route,
          configuredBinding: _configuredBinding,
          runtimeBindingId: _runtimeBindingId,
        } = resolveMatrixInboundRoute({
          cfg,
          accountId,
          roomId,
          senderId,
          isDirectMessage,
          messageId: _messageId,
          threadRootId: _threadRootId,
          eventTs: eventTs ?? undefined,
          resolveAgentRoute: core.channel.routing.resolveAgentRoute,
        });
        const agentMentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, _route.agentId);
        const selfDisplayName = content.formatted_body
          ? await getMemberDisplayName(roomId, selfUserId).catch(() => undefined)
          : undefined;
        const { wasMentioned, hasExplicitMention } = resolveMentions({
          content,
          userId: selfUserId,
          displayName: selfDisplayName,
          text: mentionPrecheckText,
          mentionRegexes: agentMentionRegexes,
        });
        if (
          isConfiguredBotSender &&
          allowBotsMode === "mentions" &&
          !isDirectMessage &&
          !wasMentioned
        ) {
          logVerboseMessage(
            `matrix: drop configured bot sender=${senderId} (allowBots=mentions, missing mention, ${roomMatchMeta})`,
          );
          await commitInboundEventIfClaimed();
          return;
        }
        const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
          cfg,
          surface: "matrix",
        });
        const useAccessGroups = cfg.commands?.useAccessGroups !== false;
        const hasControlCommandInMessage = core.channel.text.hasControlCommand(
          mentionPrecheckText,
          cfg,
        );
        const commandGate = resolveControlCommandGate({
          useAccessGroups,
          authorizers: commandAuthorizers,
          allowTextCommands,
          hasControlCommand: hasControlCommandInMessage,
        });
        const commandAuthorized = commandGate.commandAuthorized;
        if (isRoom && commandGate.shouldBlock) {
          logInboundDrop({
            log: logVerboseMessage,
            channel: "matrix",
            reason: "control command (unauthorized)",
            target: senderId,
          });
          await commitInboundEventIfClaimed();
          return;
        }
        const shouldRequireMention = isRoom
          ? roomConfig?.autoReply === true
            ? false
            : roomConfig?.autoReply === false
              ? true
              : typeof roomConfig?.requireMention === "boolean"
                ? roomConfig?.requireMention
                : true
          : false;
        const shouldBypassMention =
          allowTextCommands &&
          isRoom &&
          shouldRequireMention &&
          !wasMentioned &&
          !hasExplicitMention &&
          commandAuthorized &&
          hasControlCommandInMessage;
        const canDetectMention = agentMentionRegexes.length > 0 || hasExplicitMention;
        if (isRoom && shouldRequireMention && !wasMentioned && !shouldBypassMention) {
          if (historyLimit > 0 && pendingHistoryText) {
            const pendingEntry: HistoryEntry = {
              sender: senderId,
              body: pendingHistoryText,
              timestamp: eventTs ?? undefined,
              messageId: _messageId,
            };
            roomHistoryTracker.recordPending(roomId, pendingEntry);
          }
          logger.info("skipping room message", { roomId, reason: "no-mention" });
          await commitInboundEventIfClaimed();
          return;
        }

        if (isPollEvent) {
          const pollSnapshot = await fetchMatrixPollSnapshot(client, roomId, event).catch((err) => {
            logVerboseMessage(
              `matrix: failed resolving poll snapshot room=${roomId} id=${event.event_id ?? "unknown"}: ${String(err)}`,
            );
            return null;
          });
          if (!pollSnapshot) {
            return;
          }
          content = {
            msgtype: "m.text",
            body: pollSnapshot.text,
          } as unknown as RoomMessageEventContent;
        }

        let media: {
          path: string;
          contentType?: string;
          placeholder: string;
        } | null = null;
        let mediaDownloadFailed = false;
        const finalContentUrl =
          "url" in content && typeof content.url === "string" ? content.url : undefined;
        const finalContentFile =
          "file" in content && content.file && typeof content.file === "object"
            ? content.file
            : undefined;
        const finalMediaUrl = finalContentUrl ?? finalContentFile?.url;
        const contentBody = typeof content.body === "string" ? content.body.trim() : "";
        const contentFilename = typeof content.filename === "string" ? content.filename.trim() : "";
        const originalFilename = contentFilename || contentBody || undefined;
        const contentInfo =
          "info" in content && content.info && typeof content.info === "object"
            ? (content.info as { mimetype?: string; size?: number })
            : undefined;
        const contentType = contentInfo?.mimetype;
        const contentSize = typeof contentInfo?.size === "number" ? contentInfo.size : undefined;
        if (finalMediaUrl?.startsWith("mxc://")) {
          try {
            media = await downloadMatrixMedia({
              client,
              mxcUrl: finalMediaUrl,
              contentType,
              sizeBytes: contentSize,
              maxBytes: mediaMaxBytes,
              file: finalContentFile,
              originalFilename,
            });
          } catch (err) {
            mediaDownloadFailed = true;
            const errorText = err instanceof Error ? err.message : String(err);
            logVerboseMessage(
              `matrix: media download failed room=${roomId} id=${event.event_id ?? "unknown"} type=${content.msgtype} error=${errorText}`,
            );
            logger.warn("matrix media download failed", {
              roomId,
              eventId: event.event_id,
              msgtype: content.msgtype,
              encrypted: Boolean(finalContentFile),
              error: errorText,
            });
          }
        }

        const rawBody = locationPayload?.text ?? contentBody;
        const bodyText = resolveMatrixInboundBodyText({
          rawBody,
          filename: typeof content.filename === "string" ? content.filename : undefined,
          mediaPlaceholder: media?.placeholder,
          msgtype: content.msgtype,
          hadMediaUrl: Boolean(finalMediaUrl),
          mediaDownloadFailed,
        });
        if (!bodyText) {
          await commitInboundEventIfClaimed();
          return;
        }
        const senderName = await getSenderName();
        const roomInfo = isRoom ? await getRoomInfo(roomId) : undefined;
        const roomName = roomInfo?.name;

        const replyToEventId = content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
        const threadTarget = resolveMatrixThreadTarget({
          threadReplies,
          messageId: _messageId,
          threadRootId: _threadRootId,
          isThreadRoot: false,
        });
        const threadContext = _threadRootId
          ? await resolveThreadContext({ roomId, threadRootId: _threadRootId })
          : undefined;
        const replyContext =
          replyToEventId && replyToEventId === _threadRootId && threadContext?.summary
            ? {
                replyToBody: threadContext.summary,
                replyToSender: threadContext.senderLabel,
              }
            : replyToEventId
              ? await resolveReplyContext({ roomId, eventId: replyToEventId })
              : undefined;

        if (_configuredBinding) {
          const ensured = await ensureConfiguredAcpBindingReady({
            cfg,
            configuredBinding: _configuredBinding,
          });
          if (!ensured.ok) {
            logInboundDrop({
              log: logVerboseMessage,
              channel: "matrix",
              reason: "configured ACP binding unavailable",
              target: _configuredBinding.spec.conversationId,
            });
            return;
          }
        }
        if (_runtimeBindingId) {
          getSessionBindingService().touch(_runtimeBindingId, eventTs ?? undefined);
        }
        const envelopeFrom = isDirectMessage ? senderName : (roomName ?? roomId);
        const preparedTrigger =
          isRoom && historyLimit > 0
            ? roomHistoryTracker.prepareTrigger(_route.agentId, roomId, historyLimit, {
                sender: senderName,
                body: bodyText,
                timestamp: eventTs ?? undefined,
                messageId: _messageId,
              })
            : undefined;
        const inboundHistory = preparedTrigger?.history;
        const triggerSnapshotIdx = preparedTrigger?.snapshotIdx ?? -1;

        const textWithId = `${bodyText}\n[matrix event id: ${_messageId} room: ${roomId}]`;
        const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
          agentId: _route.agentId,
        });
        const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
        const previousTimestamp = core.channel.session.readSessionUpdatedAt({
          storePath,
          sessionKey: _route.sessionKey,
        });
        const body = core.channel.reply.formatAgentEnvelope({
          channel: "Matrix",
          from: envelopeFrom,
          timestamp: eventTs ?? undefined,
          previousTimestamp,
          envelope: envelopeOptions,
          body: textWithId,
        });

        const groupSystemPrompt = roomConfig?.systemPrompt?.trim() || undefined;
        const ctxPayload = core.channel.reply.finalizeInboundContext({
          Body: body,
          RawBody: bodyText,
          CommandBody: bodyText,
          InboundHistory: inboundHistory && inboundHistory.length > 0 ? inboundHistory : undefined,
          From: isDirectMessage ? `matrix:${senderId}` : `matrix:channel:${roomId}`,
          To: `room:${roomId}`,
          SessionKey: _route.sessionKey,
          AccountId: _route.accountId,
          ChatType: isDirectMessage ? "direct" : "channel",
          ConversationLabel: envelopeFrom,
          SenderName: senderName,
          SenderId: senderId,
          SenderUsername: senderId.split(":")[0]?.replace(/^@/, ""),
          GroupSubject: isRoom ? (roomName ?? roomId) : undefined,
          GroupId: isRoom ? roomId : undefined,
          GroupSystemPrompt: isRoom ? groupSystemPrompt : undefined,
          Provider: "matrix" as const,
          Surface: "matrix" as const,
          WasMentioned: isRoom ? wasMentioned : undefined,
          MessageSid: _messageId,
          ReplyToId: threadTarget ? undefined : (replyToEventId ?? undefined),
          ReplyToBody: replyContext?.replyToBody,
          ReplyToSender: replyContext?.replyToSender,
          MessageThreadId: threadTarget,
          ThreadStarterBody: threadContext?.threadStarterBody,
          Timestamp: eventTs ?? undefined,
          MediaPath: media?.path,
          MediaType: media?.contentType,
          MediaUrl: media?.path,
          ...locationPayload?.context,
          CommandAuthorized: commandAuthorized,
          CommandSource: "text" as const,
          OriginatingChannel: "matrix" as const,
          OriginatingTo: `room:${roomId}`,
        });

        await core.channel.session.recordInboundSession({
          storePath,
          sessionKey: ctxPayload.SessionKey ?? _route.sessionKey,
          ctx: ctxPayload,
          updateLastRoute: isDirectMessage
            ? {
                sessionKey: _route.mainSessionKey,
                channel: "matrix",
                to: `room:${roomId}`,
                accountId: _route.accountId,
              }
            : undefined,
          onRecordError: (err) => {
            logger.warn("failed updating session meta", {
              error: String(err),
              storePath,
              sessionKey: ctxPayload.SessionKey ?? _route.sessionKey,
            });
          },
        });

        const preview = bodyText.slice(0, 200).replace(/\n/g, "\\n");
        logVerboseMessage(`matrix inbound: room=${roomId} from=${senderId} preview="${preview}"`);

        const replyTarget = ctxPayload.To;
        if (!replyTarget) {
          runtime.error?.("matrix: missing reply target");
          return;
        }

        return {
          ctxPayload,
          route: _route,
          roomConfig,
          isDirectMessage,
          isRoom,
          shouldRequireMention,
          wasMentioned,
          shouldBypassMention,
          canDetectMention,
          messageId: _messageId,
          triggerSnapshotIdx,
          threadTarget,
          replyTarget,
        };
      });
      if (!ingressResult) {
        return;
      }

      const {
        ctxPayload,
        route: _route,
        roomConfig,
        isDirectMessage,
        isRoom,
        shouldRequireMention,
        wasMentioned,
        shouldBypassMention,
        canDetectMention,
        messageId: _messageId,
        triggerSnapshotIdx,
        threadTarget,
        replyTarget,
      } = ingressResult;

      const { ackReaction, ackReactionScope: ackScope } = resolveMatrixAckReactionConfig({
        cfg,
        agentId: _route.agentId,
        accountId,
      });
      const shouldAckReaction = () =>
        Boolean(
          ackReaction &&
          core.channel.reactions.shouldAckReaction({
            scope: ackScope,
            isDirect: isDirectMessage,
            isGroup: isRoom,
            isMentionableGroup: isRoom,
            requireMention: Boolean(shouldRequireMention),
            canDetectMention,
            effectiveWasMentioned: wasMentioned || shouldBypassMention,
            shouldBypassMention,
          }),
        );
      if (shouldAckReaction() && _messageId) {
        reactMatrixMessage(roomId, _messageId, ackReaction, client).catch((err) => {
          logVerboseMessage(`matrix react failed for room ${roomId}: ${String(err)}`);
        });
      }

      if (_messageId) {
        sendReadReceiptMatrix(roomId, _messageId, client).catch((err) => {
          logVerboseMessage(
            `matrix: read receipt failed room=${roomId} id=${_messageId}: ${String(err)}`,
          );
        });
      }

      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "matrix",
        accountId: _route.accountId,
      });
      const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, _route.agentId);
      let finalReplyDeliveryFailed = false;
      let nonFinalReplyDeliveryFailed = false;
      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg,
        agentId: _route.agentId,
        channel: "matrix",
        accountId: _route.accountId,
      });
      const typingCallbacks = createTypingCallbacks({
        start: () => sendTypingMatrix(roomId, true, undefined, client),
        stop: () => sendTypingMatrix(roomId, false, undefined, client),
        onStartError: (err) => {
          logTypingFailure({
            log: logVerboseMessage,
            channel: "matrix",
            action: "start",
            target: roomId,
            error: err,
          });
        },
        onStopError: (err) => {
          logTypingFailure({
            log: logVerboseMessage,
            channel: "matrix",
            action: "stop",
            target: roomId,
            error: err,
          });
        },
      });
      const streamingEnabled = streaming === "partial";
      const draftReplyToId = replyToMode !== "off" && !threadTarget ? _messageId : undefined;
      let currentDraftReplyToId = draftReplyToId;
      const draftStream = streamingEnabled
        ? createMatrixDraftStream({
            roomId,
            client,
            cfg,
            threadId: threadTarget,
            replyToId: draftReplyToId,
            preserveReplyId: replyToMode === "all",
            accountId: _route.accountId,
            log: logVerboseMessage,
          })
        : undefined;
      draftStreamRef = draftStream;
      // Track how much of the full accumulated text has been materialized
      // (delivered) so each new block only streams the new portion.
      let materializedTextLength = 0;
      let lastPartialFullTextLength = 0;
      // Set after the first final payload consumes the draft event so
      // subsequent finals go through normal delivery.
      let draftConsumed = false;

      const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } =
        core.channel.reply.createReplyDispatcherWithTyping({
          ...prefixOptions,
          humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, _route.agentId),
          deliver: async (payload: ReplyPayload, info: { kind: string }) => {
            if (draftStream && info.kind !== "tool" && !payload.isCompactionNotice) {
              const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;

              await draftStream.stop();

              // After the first final payload consumes the draft, subsequent
              // finals must go through normal delivery to avoid overwriting.
              if (draftConsumed) {
                await deliverMatrixReplies({
                  cfg,
                  replies: [payload],
                  roomId,
                  client,
                  runtime,
                  textLimit,
                  replyToMode,
                  threadId: threadTarget,
                  accountId: _route.accountId,
                  mediaLocalRoots,
                  tableMode,
                });
                return;
              }

              // Read event id after stop() — flush may have created the
              // initial message while draining pending text.
              const draftEventId = draftStream.eventId();

              // If the payload carries a reply target that differs from the
              // draft's, fall through to normal delivery — Matrix edits
              // cannot change the reply relation on an existing event.
              // Skip when replyToMode is "off" (replies stripped anyway)
              // or when threadTarget is set (thread relations take
              // precedence over replyToId in deliverMatrixReplies).
              const payloadReplyToId = payload.replyToId?.trim() || undefined;
              const payloadReplyMismatch =
                replyToMode !== "off" &&
                !threadTarget &&
                payloadReplyToId !== currentDraftReplyToId;
              const mustDeliverFinalNormally = draftStream.mustDeliverFinalNormally();

              if (
                draftEventId &&
                payload.text &&
                !hasMedia &&
                !payloadReplyMismatch &&
                !mustDeliverFinalNormally
              ) {
                // Text-only: final edit of the draft message.  Skip if
                // stop() already flushed identical text to avoid a
                // redundant API call that wastes rate-limit budget.
                if (payload.text !== draftStream.lastSentText()) {
                  try {
                    await editMessageMatrix(roomId, draftEventId, payload.text, {
                      client,
                      cfg,
                      threadId: threadTarget,
                      accountId: _route.accountId,
                    });
                  } catch {
                    // Edit failed (rate limit, server error) — redact the
                    // stale draft and fall back to normal delivery so the
                    // user still gets the final answer.
                    await client.redactEvent(roomId, draftEventId).catch(() => {});
                    await deliverMatrixReplies({
                      cfg,
                      replies: [payload],
                      roomId,
                      client,
                      runtime,
                      textLimit,
                      replyToMode,
                      threadId: threadTarget,
                      accountId: _route.accountId,
                      mediaLocalRoots,
                      tableMode,
                    });
                  }
                }
                draftConsumed = true;
              } else if (draftEventId && hasMedia && !payloadReplyMismatch) {
                // Media payload: finalize draft text, send media separately.
                let textEditOk = !mustDeliverFinalNormally;
                if (textEditOk && payload.text && payload.text !== draftStream.lastSentText()) {
                  textEditOk = await editMessageMatrix(roomId, draftEventId, payload.text, {
                    client,
                    cfg,
                    threadId: threadTarget,
                    accountId: _route.accountId,
                  }).then(
                    () => true,
                    () => false,
                  );
                }
                const reusesDraftAsFinalText = Boolean(payload.text?.trim()) && textEditOk;
                // If the text edit failed, or there is no final text to reuse
                // the preview, redact the stale draft and include text in media
                // delivery so the final caption is not lost.
                if (!reusesDraftAsFinalText) {
                  await client.redactEvent(roomId, draftEventId).catch(() => {});
                }
                await deliverMatrixReplies({
                  cfg,
                  replies: [
                    { ...payload, text: reusesDraftAsFinalText ? undefined : payload.text },
                  ],
                  roomId,
                  client,
                  runtime,
                  textLimit,
                  replyToMode,
                  threadId: threadTarget,
                  accountId: _route.accountId,
                  mediaLocalRoots,
                  tableMode,
                });
                draftConsumed = true;
              } else {
                // Redact stale draft when the final delivery will create a
                // new message (reply-target mismatch, preview overflow, or no
                // usable draft).
                if (draftEventId && (payloadReplyMismatch || mustDeliverFinalNormally)) {
                  await client.redactEvent(roomId, draftEventId).catch(() => {});
                }
                await deliverMatrixReplies({
                  cfg,
                  replies: [payload],
                  roomId,
                  client,
                  runtime,
                  textLimit,
                  replyToMode,
                  threadId: threadTarget,
                  accountId: _route.accountId,
                  mediaLocalRoots,
                  tableMode,
                });
              }

              // Only reset for intermediate blocks — after the final delivery
              // the stream must stay stopped so late async callbacks cannot
              // create ghost messages.
              if (info.kind === "block") {
                materializedTextLength = lastPartialFullTextLength;
                draftConsumed = false;
                draftStream.reset();
                currentDraftReplyToId = replyToMode === "all" ? draftReplyToId : undefined;

                // Re-assert typing so the user still sees the indicator while
                // the next block generates.
                await sendTypingMatrix(roomId, true, undefined, client).catch(() => {});
              }
            } else {
              await deliverMatrixReplies({
                cfg,
                replies: [payload],
                roomId,
                client,
                runtime,
                textLimit,
                replyToMode,
                threadId: threadTarget,
                accountId: _route.accountId,
                mediaLocalRoots,
                tableMode,
              });
            }
          },
          onError: (err: unknown, info: { kind: "tool" | "block" | "final" }) => {
            if (info.kind === "final") {
              finalReplyDeliveryFailed = true;
            } else {
              nonFinalReplyDeliveryFailed = true;
            }
            runtime.error?.(`matrix ${info.kind} reply failed: ${String(err)}`);
          },
          onReplyStart: typingCallbacks.onReplyStart,
          onIdle: typingCallbacks.onIdle,
        });

      const { queuedFinal, counts } = await core.channel.reply.withReplyDispatcher({
        dispatcher,
        onSettled: () => {
          markDispatchIdle();
        },
        run: async () => {
          try {
            return await core.channel.reply.dispatchReplyFromConfig({
              ctx: ctxPayload,
              cfg,
              dispatcher,
              replyOptions: {
                ...replyOptions,
                skillFilter: roomConfig?.skills,
                // When streaming is active, disable block streaming — draft
                // streaming replaces it with edit-in-place updates.
                disableBlockStreaming: streamingEnabled ? true : undefined,
                onPartialReply: draftStream
                  ? (payload) => {
                      const fullText = payload.text ?? "";
                      lastPartialFullTextLength = fullText.length;
                      const blockText = fullText.slice(materializedTextLength);
                      if (blockText) {
                        draftStream.update(blockText);
                      }
                    }
                  : undefined,
                // Reset text offset on assistant message boundaries so
                // post-tool blocks stream correctly (payload.text resets
                // per assistant message upstream).
                onAssistantMessageStart: draftStream
                  ? () => {
                      materializedTextLength = 0;
                      lastPartialFullTextLength = 0;
                    }
                  : undefined,
                onModelSelected,
              },
            });
          } finally {
            markRunComplete();
          }
        },
      });
      if (finalReplyDeliveryFailed) {
        logVerboseMessage(
          `matrix: final reply delivery failed room=${roomId} id=${_messageId}; leaving event uncommitted`,
        );
        // Do not advance watermark — the event will be retried and should see the same history.
        return;
      }
      if (!queuedFinal && nonFinalReplyDeliveryFailed) {
        logVerboseMessage(
          `matrix: non-final reply delivery failed room=${roomId} id=${_messageId}; leaving event uncommitted`,
        );
        // Do not advance watermark — the event will be retried.
        return;
      }
      // Advance the per-agent watermark now that the reply succeeded (or no reply was needed).
      // Only advance to the snapshot position — messages added during async processing remain
      // visible for the next trigger.
      if (isRoom && triggerSnapshotIdx >= 0) {
        roomHistoryTracker.consumeHistory(_route.agentId, roomId, triggerSnapshotIdx, _messageId);
      }
      if (!queuedFinal) {
        await commitInboundEventIfClaimed();
        return;
      }
      const finalCount = counts.final;
      logVerboseMessage(
        `matrix: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
      );
      await commitInboundEventIfClaimed();
    } catch (err) {
      runtime.error?.(`matrix handler failed: ${String(err)}`);
    } finally {
      // Stop the draft stream timer so partial drafts don't leak if the
      // model run throws or times out mid-stream.
      if (draftStreamRef) {
        await draftStreamRef.stop().catch(() => {});
      }
      if (claimedInboundEvent && inboundDeduper && eventId) {
        inboundDeduper.releaseEvent({ roomId, eventId });
      }
    }
  };
}
