import type { LocationMessageEventContent, MatrixClient } from "@vector-im/matrix-bot-sdk";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  formatAllowlistMatchMeta,
  logInboundDrop,
  logTypingFailure,
  resolveControlCommandGate,
  type PluginRuntime,
  type RuntimeEnv,
  type RuntimeLogger,
} from "openclaw/plugin-sdk";
import type { CoreConfig, MatrixRoomConfig, ReplyToMode } from "../../types.js";
import { fetchEventSummary } from "../actions/summary.js";
import {
  formatPollAsText,
  isPollStartType,
  parsePollStartContent,
  type PollStartContent,
} from "../poll-types.js";
import {
  reactMatrixMessage,
  sendMessageMatrix,
  sendReadReceiptMatrix,
  sendTypingMatrix,
} from "../send.js";
import {
  normalizeMatrixAllowList,
  resolveMatrixAllowListMatch,
  resolveMatrixAllowListMatches,
} from "./allowlist.js";
import { resolveMatrixLocation, type MatrixLocationPayload } from "./location.js";
import { downloadMatrixMedia } from "./media.js";
import { resolveMentions } from "./mentions.js";
import { deliverMatrixReplies } from "./replies.js";
import { resolveMatrixRoomConfig } from "./rooms.js";
import { resolveMatrixThreadRootId, resolveMatrixThreadTarget } from "./threads.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";
import { EventType, RelationType } from "./types.js";

export type MatrixMonitorHandlerParams = {
  client: MatrixClient;
  core: PluginRuntime;
  cfg: CoreConfig;
  runtime: RuntimeEnv;
  logger: RuntimeLogger;
  logVerboseMessage: (message: string) => void;
  allowFrom: string[];
  roomsConfig: Record<string, MatrixRoomConfig> | undefined;
  mentionRegexes: ReturnType<PluginRuntime["channel"]["mentions"]["buildMentionRegexes"]>;
  groupPolicy: "open" | "allowlist" | "disabled";
  replyToMode: ReplyToMode;
  threadReplies: "off" | "inbound" | "always";
  dmEnabled: boolean;
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  textLimit: number;
  mediaMaxBytes: number;
  startupMs: number;
  startupGraceMs: number;
  directTracker: {
    isDirectMessage: (params: {
      roomId: string;
      senderId: string;
      selfUserId: string;
    }) => Promise<boolean>;
  };
  getRoomInfo: (
    roomId: string,
  ) => Promise<{ name?: string; canonicalAlias?: string; altAliases: string[] }>;
  getMemberDisplayName: (roomId: string, userId: string) => Promise<string>;
  accountId?: string | null;
};

export function createMatrixRoomMessageHandler(params: MatrixMonitorHandlerParams) {
  const {
    client,
    core,
    cfg,
    runtime,
    logger,
    logVerboseMessage,
    allowFrom,
    roomsConfig,
    mentionRegexes,
    groupPolicy,
    replyToMode,
    threadReplies,
    dmEnabled,
    dmPolicy,
    textLimit,
    mediaMaxBytes,
    startupMs,
    startupGraceMs,
    directTracker,
    getRoomInfo,
    getMemberDisplayName,
    accountId,
  } = params;

  return async (roomId: string, event: MatrixRawEvent) => {
    try {
      const eventType = event.type;
      if (eventType === EventType.RoomMessageEncrypted) {
        // Encrypted messages are decrypted automatically by @vector-im/matrix-bot-sdk with crypto enabled
        return;
      }

      const isPollEvent = isPollStartType(eventType);
      const locationContent = event.content as unknown as LocationMessageEventContent;
      const isLocationEvent =
        eventType === EventType.Location ||
        (eventType === EventType.RoomMessage && locationContent.msgtype === EventType.Location);
      if (eventType !== EventType.RoomMessage && !isPollEvent && !isLocationEvent) {
        return;
      }
      logVerboseMessage(
        `matrix: room.message recv room=${roomId} type=${eventType} id=${event.event_id ?? "unknown"}`,
      );
      if (event.unsigned?.redacted_because) {
        return;
      }
      const senderId = event.sender;
      if (!senderId) {
        return;
      }
      const selfUserId = await client.getUserId();
      if (senderId === selfUserId) {
        return;
      }
      const eventTs = event.origin_server_ts;
      const eventAge = event.unsigned?.age;
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

      const roomInfo = await getRoomInfo(roomId);
      const roomName = roomInfo.name;
      const roomAliases = [roomInfo.canonicalAlias ?? "", ...roomInfo.altAliases].filter(Boolean);

      let content = event.content as unknown as RoomMessageEventContent;
      if (isPollEvent) {
        const pollStartContent = event.content as unknown as PollStartContent;
        const pollSummary = parsePollStartContent(pollStartContent);
        if (pollSummary) {
          pollSummary.eventId = event.event_id ?? "";
          pollSummary.roomId = roomId;
          pollSummary.sender = senderId;
          const senderDisplayName = await getMemberDisplayName(roomId, senderId);
          pollSummary.senderName = senderDisplayName;
          const pollText = formatPollAsText(pollSummary);
          content = {
            msgtype: "m.text",
            body: pollText,
          } as unknown as RoomMessageEventContent;
        } else {
          return;
        }
      }

      const locationPayload: MatrixLocationPayload | null = resolveMatrixLocation({
        eventType,
        content: content as LocationMessageEventContent,
      });

      const relates = content["m.relates_to"];
      if (relates && "rel_type" in relates) {
        if (relates.rel_type === RelationType.Replace) {
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
        return;
      }

      const roomConfigInfo = isRoom
        ? resolveMatrixRoomConfig({
            rooms: roomsConfig,
            roomId,
            aliases: roomAliases,
            name: roomName,
          })
        : undefined;
      const roomConfig = roomConfigInfo?.config;
      const roomMatchMeta = roomConfigInfo
        ? `matchKey=${roomConfigInfo.matchKey ?? "none"} matchSource=${
            roomConfigInfo.matchSource ?? "none"
          }`
        : "matchKey=none matchSource=none";

      if (isRoom && roomConfig && !roomConfigInfo?.allowed) {
        logVerboseMessage(`matrix: room disabled room=${roomId} (${roomMatchMeta})`);
        return;
      }
      if (isRoom && groupPolicy === "allowlist") {
        if (!roomConfigInfo?.allowlistConfigured) {
          logVerboseMessage(`matrix: drop room message (no allowlist, ${roomMatchMeta})`);
          return;
        }
        if (!roomConfig) {
          logVerboseMessage(`matrix: drop room message (not in allowlist, ${roomMatchMeta})`);
          return;
        }
      }

      const senderName = await getMemberDisplayName(roomId, senderId);
      const storeAllowFrom = await core.channel.pairing
        .readAllowFromStore("matrix")
        .catch(() => []);
      const effectiveAllowFrom = normalizeMatrixAllowList([...allowFrom, ...storeAllowFrom]);
      const groupAllowFrom = cfg.channels?.matrix?.groupAllowFrom ?? [];
      const effectiveGroupAllowFrom = normalizeMatrixAllowList(groupAllowFrom);
      const groupAllowConfigured = effectiveGroupAllowFrom.length > 0;

      if (isDirectMessage) {
        if (!dmEnabled || dmPolicy === "disabled") {
          return;
        }
        if (dmPolicy !== "open") {
          const allowMatch = resolveMatrixAllowListMatch({
            allowList: effectiveAllowFrom,
            userId: senderId,
          });
          const allowMatchMeta = formatAllowlistMatchMeta(allowMatch);
          if (!allowMatch.allowed) {
            if (dmPolicy === "pairing") {
              const { code, created } = await core.channel.pairing.upsertPairingRequest({
                channel: "matrix",
                id: senderId,
                meta: { name: senderName },
              });
              if (created) {
                logVerboseMessage(
                  `matrix pairing request sender=${senderId} name=${senderName ?? "unknown"} (${allowMatchMeta})`,
                );
                try {
                  await sendMessageMatrix(
                    `room:${roomId}`,
                    [
                      "OpenClaw: access not configured.",
                      "",
                      `Pairing code: ${code}`,
                      "",
                      "Ask the bot owner to approve with:",
                      "openclaw pairing approve matrix <code>",
                    ].join("\n"),
                    { client },
                  );
                } catch (err) {
                  logVerboseMessage(`matrix pairing reply failed for ${senderId}: ${String(err)}`);
                }
              }
            }
            if (dmPolicy !== "pairing") {
              logVerboseMessage(
                `matrix: blocked dm sender ${senderId} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
              );
            }
            return;
          }
        }
      }

      const roomUsers = roomConfig?.users ?? [];
      if (isRoom && roomUsers.length > 0) {
        const userMatch = resolveMatrixAllowListMatch({
          allowList: normalizeMatrixAllowList(roomUsers),
          userId: senderId,
        });
        if (!userMatch.allowed) {
          logVerboseMessage(
            `matrix: blocked sender ${senderId} (room users allowlist, ${roomMatchMeta}, ${formatAllowlistMatchMeta(
              userMatch,
            )})`,
          );
          return;
        }
      }
      if (isRoom && groupPolicy === "allowlist" && roomUsers.length === 0 && groupAllowConfigured) {
        const groupAllowMatch = resolveMatrixAllowListMatch({
          allowList: effectiveGroupAllowFrom,
          userId: senderId,
        });
        if (!groupAllowMatch.allowed) {
          logVerboseMessage(
            `matrix: blocked sender ${senderId} (groupAllowFrom, ${roomMatchMeta}, ${formatAllowlistMatchMeta(
              groupAllowMatch,
            )})`,
          );
          return;
        }
      }
      if (isRoom) {
        logVerboseMessage(`matrix: allow room ${roomId} (${roomMatchMeta})`);
      }

      const rawBody =
        locationPayload?.text ?? (typeof content.body === "string" ? content.body.trim() : "");
      let media: {
        path: string;
        contentType?: string;
        placeholder: string;
      } | null = null;
      const contentUrl =
        "url" in content && typeof content.url === "string" ? content.url : undefined;
      const contentFile =
        "file" in content && content.file && typeof content.file === "object"
          ? content.file
          : undefined;
      const mediaUrl = contentUrl ?? contentFile?.url;
      if (!rawBody && !mediaUrl) {
        return;
      }

      const contentInfo =
        "info" in content && content.info && typeof content.info === "object"
          ? (content.info as { mimetype?: string; size?: number })
          : undefined;
      const contentType = contentInfo?.mimetype;
      const contentSize = typeof contentInfo?.size === "number" ? contentInfo.size : undefined;
      if (mediaUrl?.startsWith("mxc://")) {
        try {
          media = await downloadMatrixMedia({
            client,
            mxcUrl: mediaUrl,
            contentType,
            sizeBytes: contentSize,
            maxBytes: mediaMaxBytes,
            file: contentFile,
          });
        } catch (err) {
          logVerboseMessage(`matrix: media download failed: ${String(err)}`);
        }
      }

      const bodyText = rawBody || media?.placeholder || "";
      if (!bodyText) {
        return;
      }

      const { wasMentioned, hasExplicitMention } = resolveMentions({
        content,
        userId: selfUserId,
        text: bodyText,
        mentionRegexes,
      });
      const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
        cfg,
        surface: "matrix",
      });
      const useAccessGroups = cfg.commands?.useAccessGroups !== false;
      const senderAllowedForCommands = resolveMatrixAllowListMatches({
        allowList: effectiveAllowFrom,
        userId: senderId,
      });
      const senderAllowedForGroup = groupAllowConfigured
        ? resolveMatrixAllowListMatches({
            allowList: effectiveGroupAllowFrom,
            userId: senderId,
          })
        : false;
      const senderAllowedForRoomUsers =
        isRoom && roomUsers.length > 0
          ? resolveMatrixAllowListMatches({
              allowList: normalizeMatrixAllowList(roomUsers),
              userId: senderId,
            })
          : false;
      const hasControlCommandInMessage = core.channel.text.hasControlCommand(bodyText, cfg);
      const commandGate = resolveControlCommandGate({
        useAccessGroups,
        authorizers: [
          { configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands },
          { configured: roomUsers.length > 0, allowed: senderAllowedForRoomUsers },
          { configured: groupAllowConfigured, allowed: senderAllowedForGroup },
        ],
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
      const canDetectMention = mentionRegexes.length > 0 || hasExplicitMention;
      if (isRoom && shouldRequireMention && !wasMentioned && !shouldBypassMention) {
        logger.info("skipping room message", { roomId, reason: "no-mention" });
        return;
      }

      const messageId = event.event_id ?? "";
      const replyToEventId = content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
      const threadRootId = resolveMatrixThreadRootId({ event, content });
      const threadTarget = resolveMatrixThreadTarget({
        threadReplies,
        messageId,
        threadRootId,
        isThreadRoot: false, // @vector-im/matrix-bot-sdk doesn't have this info readily available
      });

      const baseRoute = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "matrix",
        accountId,
        peer: {
          kind: isDirectMessage ? "direct" : "channel",
          id: isDirectMessage ? senderId : roomId,
        },
      });

      const route = {
        ...baseRoute,
        sessionKey: threadRootId
          ? `${baseRoute.sessionKey}:thread:${threadRootId}`
          : baseRoute.sessionKey,
      };

      let threadStarterBody: string | undefined;
      let threadLabel: string | undefined;
      let parentSessionKey: string | undefined;

      if (threadRootId) {
        const existingSession = core.channel.session.readSessionUpdatedAt({
          storePath: core.channel.session.resolveStorePath(cfg.session?.store, {
            agentId: baseRoute.agentId,
          }),
          sessionKey: route.sessionKey,
        });

        if (existingSession === undefined) {
          try {
            const rootEvent = await fetchEventSummary(client, roomId, threadRootId);
            if (rootEvent?.body) {
              const rootSenderName = rootEvent.sender
                ? await getMemberDisplayName(roomId, rootEvent.sender)
                : undefined;

              threadStarterBody = core.channel.reply.formatAgentEnvelope({
                channel: "Matrix",
                from: rootSenderName ?? rootEvent.sender ?? "Unknown",
                timestamp: rootEvent.timestamp,
                envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg),
                body: rootEvent.body,
              });

              threadLabel = `Matrix thread in ${roomName ?? roomId}`;
              parentSessionKey = baseRoute.sessionKey;
            }
          } catch (err) {
            logVerboseMessage(
              `matrix: failed to fetch thread root ${threadRootId}: ${String(err)}`,
            );
          }
        }
      }

      const envelopeFrom = isDirectMessage ? senderName : (roomName ?? roomId);
      const textWithId = threadRootId
        ? `${bodyText}\n[matrix event id: ${messageId} room: ${roomId} thread: ${threadRootId}]`
        : `${bodyText}\n[matrix event id: ${messageId} room: ${roomId}]`;
      const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
        agentId: route.agentId,
      });
      const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
      const previousTimestamp = core.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
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
        BodyForAgent: bodyText,
        RawBody: bodyText,
        CommandBody: bodyText,
        From: isDirectMessage ? `matrix:${senderId}` : `matrix:channel:${roomId}`,
        To: `room:${roomId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: threadRootId ? "thread" : isDirectMessage ? "direct" : "channel",
        ConversationLabel: envelopeFrom,
        SenderName: senderName,
        SenderId: senderId,
        SenderUsername: senderId.split(":")[0]?.replace(/^@/, ""),
        GroupSubject: isRoom ? (roomName ?? roomId) : undefined,
        GroupChannel: isRoom ? (roomInfo.canonicalAlias ?? roomId) : undefined,
        GroupSystemPrompt: isRoom ? groupSystemPrompt : undefined,
        Provider: "matrix" as const,
        Surface: "matrix" as const,
        WasMentioned: isRoom ? wasMentioned : undefined,
        MessageSid: messageId,
        ReplyToId: threadTarget ? undefined : (replyToEventId ?? undefined),
        MessageThreadId: threadTarget,
        Timestamp: eventTs ?? undefined,
        MediaPath: media?.path,
        MediaType: media?.contentType,
        MediaUrl: media?.path,
        ...locationPayload?.context,
        CommandAuthorized: commandAuthorized,
        CommandSource: "text" as const,
        OriginatingChannel: "matrix" as const,
        OriginatingTo: `room:${roomId}`,
        ThreadStarterBody: threadStarterBody,
        ThreadLabel: threadLabel,
        ParentSessionKey: parentSessionKey,
      });

      await core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        updateLastRoute: isDirectMessage
          ? {
              sessionKey: route.mainSessionKey,
              channel: "matrix",
              to: `room:${roomId}`,
              accountId: route.accountId,
            }
          : undefined,
        onRecordError: (err) => {
          logger.warn("failed updating session meta", {
            error: String(err),
            storePath,
            sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
          });
        },
      });

      const preview = bodyText.slice(0, 200).replace(/\n/g, "\\n");
      logVerboseMessage(`matrix inbound: room=${roomId} from=${senderId} preview="${preview}"`);

      const ackReaction = (cfg.messages?.ackReaction ?? "").trim();
      const ackScope = cfg.messages?.ackReactionScope ?? "group-mentions";
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
      if (shouldAckReaction() && messageId) {
        reactMatrixMessage(roomId, messageId, ackReaction, client).catch((err) => {
          logVerboseMessage(`matrix react failed for room ${roomId}: ${String(err)}`);
        });
      }

      const replyTarget = ctxPayload.To;
      if (!replyTarget) {
        runtime.error?.("matrix: missing reply target");
        return;
      }

      if (messageId) {
        sendReadReceiptMatrix(roomId, messageId, client).catch((err) => {
          logVerboseMessage(
            `matrix: read receipt failed room=${roomId} id=${messageId}: ${String(err)}`,
          );
        });
      }

      let didSendReply = false;
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "matrix",
        accountId: route.accountId,
      });
      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg,
        agentId: route.agentId,
        channel: "matrix",
        accountId: route.accountId,
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
      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          ...prefixOptions,
          humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
          deliver: async (payload) => {
            await deliverMatrixReplies({
              replies: [payload],
              roomId,
              client,
              runtime,
              textLimit,
              replyToMode,
              threadId: threadTarget,
              accountId: route.accountId,
              tableMode,
            });
            didSendReply = true;
          },
          onError: (err, info) => {
            runtime.error?.(`matrix ${info.kind} reply failed: ${String(err)}`);
          },
          onReplyStart: typingCallbacks.onReplyStart,
          onIdle: typingCallbacks.onIdle,
        });

      const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          skillFilter: roomConfig?.skills,
          onModelSelected,
        },
      });
      markDispatchIdle();
      if (!queuedFinal) {
        return;
      }
      didSendReply = true;
      const finalCount = counts.final;
      logVerboseMessage(
        `matrix: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
      );
      if (didSendReply) {
        const previewText = bodyText.replace(/\s+/g, " ").slice(0, 160);
        core.system.enqueueSystemEvent(`Matrix message from ${senderName}: ${previewText}`, {
          sessionKey: route.sessionKey,
          contextKey: `matrix:message:${roomId}:${messageId || "unknown"}`,
        });
      }
    } catch (err) {
      runtime.error?.(`matrix handler failed: ${String(err)}`);
    }
  };
}
