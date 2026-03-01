import type { LocationMessageEventContent, MatrixClient } from "@vector-im/matrix-bot-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  createScopedPairingAccess,
  createReplyPrefixOptions,
  createTypingCallbacks,
  formatAllowlistMatchMeta,
  logInboundDrop,
  logTypingFailure,
  recordPendingHistoryEntryIfEnabled,
  resolveControlCommandGate,
  type HistoryEntry,
  type PluginRuntime,
  type RuntimeEnv,
  type RuntimeLogger,
} from "openclaw/plugin-sdk";
import type { CoreConfig, MatrixRoomConfig, ReplyToMode } from "../../types.js";
import { resolveMatrixAccount } from "../accounts.js";
import { fetchEventSummary } from "../actions/summary.js";
import {
  formatPollAsText,
  isPollStartType,
  parsePollStartContent,
  type PollStartContent,
} from "../poll-types.js";
import { reactMatrixMessage, sendMessageMatrix, sendTypingMatrix } from "../send.js";
import { enforceMatrixDirectMessageAccess, resolveMatrixAccessState } from "./access-policy.js";
import {
  normalizeMatrixAllowList,
  normalizeMatrixUserId,
  resolveMatrixAllowListMatch,
  resolveMatrixAllowListMatches,
} from "./allowlist.js";
import {
  resolveMatrixBodyForAgent,
  resolveMatrixInboundSenderLabel,
  resolveMatrixSenderUsername,
} from "./inbound-body.js";
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
  rawIdAllowFrom: string[];
  rawIdGroupAllowFrom: string[];
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
  historyLimit: number;
  roomHistories: Map<string, HistoryEntry[]>;
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
    rawIdAllowFrom,
    rawIdGroupAllowFrom,
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
    historyLimit,
    roomHistories,
  } = params;
  const resolvedAccountId = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const pairing = createScopedPairingAccess({
    core,
    channel: "matrix",
    accountId: resolvedAccountId,
  });

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
      const senderUsername = resolveMatrixSenderUsername(senderId);
      const senderLabel = resolveMatrixInboundSenderLabel({
        senderName,
        senderId,
        senderUsername,
      });
      const baseGroupAllowFrom = (cfg.channels?.matrix?.groupAllowFrom ?? []).map(String);
      // F5: Hot-reload — per-message live-config read supports both additions and revocations.
      // Only raw Matrix ID entries (@user:server) are hot-reloadable; display-name-resolved
      // entries are frozen at startup (revocation requires restart for those).
      const hotCfg = core.config.loadConfig() as CoreConfig;
      const hotAccountCfg = resolveMatrixAccount({
        cfg: hotCfg,
        accountId: resolvedAccountId,
      }).config;
      // Normalize live config entries and keep only raw Matrix IDs (display names can't be
      // re-resolved at runtime).
      const toNormalizedMatrixId = (e: string): string | null => {
        const norm = normalizeMatrixUserId(e);
        return norm.startsWith("@") && norm.slice(1).includes(":") ? norm : null;
      };
      const hotDmRawIds = (hotAccountCfg.dm?.allowFrom ?? [])
        .map(String)
        .map(toNormalizedMatrixId)
        .filter((id): id is string => id !== null);
      const hotGroupRawIds = (hotAccountCfg.groupAllowFrom ?? [])
        .map(String)
        .map(toNormalizedMatrixId)
        .filter((id): id is string => id !== null);
      // Display-name-resolved portion = startup list minus raw IDs tracked at startup.
      // These stay frozen; the raw-ID portion is replaced by the live config (supports revocation).
      const rawIdAllowFromSet = new Set(rawIdAllowFrom);
      const rawIdGroupAllowFromSet = new Set(rawIdGroupAllowFrom);
      const dnResolvedDm = allowFrom.filter((id) => !rawIdAllowFromSet.has(id));
      const dnResolvedGroup = baseGroupAllowFrom.filter((id) => !rawIdGroupAllowFromSet.has(id));
      const { access, effectiveAllowFrom, effectiveGroupAllowFrom, groupAllowConfigured } =
        await resolveMatrixAccessState({
          isDirectMessage,
          resolvedAccountId,
          dmPolicy,
          groupPolicy,
          allowFrom: normalizeMatrixAllowList([...dnResolvedDm, ...hotDmRawIds]),
          groupAllowFrom: normalizeMatrixAllowList([...dnResolvedGroup, ...hotGroupRawIds]),
          senderId,
          readStoreForDmPolicy: pairing.readStoreForDmPolicy,
        });

      if (isDirectMessage) {
        const allowedDirectMessage = await enforceMatrixDirectMessageAccess({
          dmEnabled,
          dmPolicy,
          accessDecision: access.decision,
          senderId,
          senderName,
          effectiveAllowFrom,
          upsertPairingRequest: pairing.upsertPairingRequest,
          sendPairingReply: async (text) => {
            await sendMessageMatrix(`room:${roomId}`, text, { client });
          },
          logVerboseMessage,
        });
        if (!allowedDirectMessage) {
          return;
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
      if (isRoom && roomUsers.length === 0 && groupAllowConfigured && access.decision !== "allow") {
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
            accountId: resolvedAccountId,
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
        // F4: Record non-mentioned messages as pending history context
        recordPendingHistoryEntryIfEnabled({
          historyMap: roomHistories,
          historyKey: roomId,
          limit: historyLimit,
          entry: {
            sender: senderName,
            body: bodyText,
            timestamp: eventTs ?? undefined,
            messageId: event.event_id ?? undefined,
          },
        });
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
      const body = core.channel.reply.formatInboundEnvelope({
        channel: "Matrix",
        from: envelopeFrom,
        timestamp: eventTs ?? undefined,
        previousTimestamp,
        envelope: envelopeOptions,
        body: textWithId,
        chatType: isDirectMessage ? "direct" : "channel",
        senderLabel,
      });

      // F4: Build history context — prepend buffered non-mentioned messages to the body
      let combinedBody = body;
      const historyKey = isRoom ? roomId : undefined;
      if (isRoom && historyKey) {
        combinedBody = buildPendingHistoryContextFromMap({
          historyMap: roomHistories,
          historyKey,
          limit: historyLimit,
          currentMessage: combinedBody,
          formatEntry: (entry) =>
            core.channel.reply.formatAgentEnvelope({
              channel: "Matrix",
              from: roomName ?? roomId,
              timestamp: entry.timestamp,
              body: `${entry.sender}: ${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
              envelope: envelopeOptions,
            }),
        });
      }

      const groupSystemPrompt = roomConfig?.systemPrompt?.trim() || undefined;
      // When history entries were prepended, use combinedBody for BodyForAgent so the
      // buffered context actually reaches the model (pipeline prefers BodyForAgent over Body).
      const bodyForAgent =
        isRoom && combinedBody !== body
          ? combinedBody
          : resolveMatrixBodyForAgent({ isDirectMessage, bodyText, senderLabel });
      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: combinedBody,
        BodyForAgent: bodyForAgent,
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
        SenderUsername: senderUsername,
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
          typingCallbacks,
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
        });

      const { queuedFinal, counts } = await core.channel.reply.withReplyDispatcher({
        dispatcher,
        onSettled: () => {
          markDispatchIdle();
        },
        run: () =>
          core.channel.reply.dispatchReplyFromConfig({
            ctx: ctxPayload,
            cfg,
            dispatcher,
            replyOptions: {
              ...replyOptions,
              skillFilter: roomConfig?.skills,
              onModelSelected,
            },
          }),
      });
      if (!queuedFinal) {
        // F4: Clear history buffer even when no reply was dispatched
        if (isRoom && historyKey) {
          clearHistoryEntriesIfEnabled({
            historyMap: roomHistories,
            historyKey,
            limit: historyLimit,
          });
        }
        return;
      }
      didSendReply = true;
      const finalCount = counts.final;
      logVerboseMessage(
        `matrix: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
      );
      // F4: Clear history buffer after successful reply
      if (isRoom && historyKey) {
        clearHistoryEntriesIfEnabled({
          historyMap: roomHistories,
          historyKey,
          limit: historyLimit,
        });
      }
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
