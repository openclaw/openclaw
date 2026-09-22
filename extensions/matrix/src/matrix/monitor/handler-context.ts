import { toInboundMediaFactsWithMetadata } from "openclaw/plugin-sdk/channel-inbound";
import {
  evaluateSupplementalContextVisibility,
  resolveChannelContextVisibilityMode,
} from "openclaw/plugin-sdk/context-visibility-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveMatrixReplyToEventId } from "../relations.js";
import { resolveMatrixAckReactionConfig } from "./ack-config.js";
import { resolveMatrixAllowListMatch } from "./allowlist.js";
import { resolveMatrixSharedDmContextNotice } from "./handler-helpers.js";
import type { MatrixIngressContent } from "./handler-ingress-content.js";
import { loadMatrixSendModule } from "./handler-runtime.js";
import type { MatrixHandlerRuntimeConfig } from "./handler-types.js";
import { createMatrixReplyContextResolver } from "./reply-context.js";
import { createMatrixThreadContextResolver } from "./thread-context.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";

export async function resolveMatrixInboundContext(config: {
  handler: MatrixHandlerRuntimeConfig;
  ingress: MatrixIngressContent;
  roomId: string;
  event: MatrixRawEvent;
  eventTs?: number;
  resolveThreadContext: ReturnType<typeof createMatrixThreadContextResolver>;
  resolveReplyContext: ReturnType<typeof createMatrixReplyContextResolver>;
  senderId: string;
  sharedDmContextNoticeRooms: Set<string>;
}) {
  const {
    handler,
    ingress,
    roomId,
    event,
    eventTs,
    resolveThreadContext,
    resolveReplyContext,
    senderId,
    sharedDmContextNoticeRooms,
  } = config;
  const {
    client,
    core,
    accountId,
    runtime,
    logVerboseMessage,
    groupPolicy,
    getRoomInfo,
    historyLimit,
    dmSessionScope,
    resolveStorePath: resolveStorePathImpl,
    createChannelInboundEnvelopeBuilder: createChannelInboundEnvelopeBuilderImpl,
    finalizeInboundContext,
  } = handler;
  const {
    cfg,
    resolveMessageIngress,
    route: _route,
    isDirectMessage,
    isRoom,
    effectiveRoomUsers,
    effectiveGroupAllowFrom,
    threadRootId,
    thread,
    senderName,
    bodyText,
    commandBodyText,
    roomConfig,
    messageId,
    inboundHistory,
    wasMentioned,
    effectiveWasMentioned,
    shouldBypassMention,
    canDetectMention,
    shouldRequireMention,
    commandAuthorized,
    locationPayload,
    media,
    preflightAudioTranscript,
    hasExplicitSessionBinding,
  } = ingress;
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg,
    channel: "matrix",
    accountId,
  });

  const replyToEventId = resolveMatrixReplyToEventId(event.content as RoomMessageEventContent);
  const threadTarget = thread.threadId;
  const isRoomContextSenderAllowed = (contextSenderId?: string): boolean => {
    if (!isRoom || !contextSenderId) {
      return true;
    }
    if (effectiveRoomUsers.length > 0) {
      return resolveMatrixAllowListMatch({
        allowList: effectiveRoomUsers,
        userId: contextSenderId,
      }).allowed;
    }
    if (groupPolicy === "allowlist" && effectiveGroupAllowFrom.length > 0) {
      return resolveMatrixAllowListMatch({
        allowList: effectiveGroupAllowFrom,
        userId: contextSenderId,
      }).allowed;
    }
    return true;
  };
  const shouldIncludeRoomContextSender = (
    kind: "thread" | "quote" | "history",
    contextSenderId?: string,
  ): boolean =>
    evaluateSupplementalContextVisibility({
      mode: contextVisibilityMode,
      kind,
      senderAllowed: isRoomContextSenderAllowed(contextSenderId),
    }).include;
  let threadContext = threadRootId
    ? await resolveThreadContext({ roomId, threadRootId })
    : undefined;
  if (
    threadContext?.senderId &&
    !shouldIncludeRoomContextSender("thread", threadContext.senderId)
  ) {
    logVerboseMessage(`matrix: drop thread root context (mode=${contextVisibilityMode})`);
    threadContext = undefined;
  }
  let replyContext: Awaited<ReturnType<typeof resolveReplyContext>> | undefined;
  if (replyToEventId && replyToEventId === threadRootId && threadContext?.summary) {
    replyContext = {
      replyToBody: threadContext.summary,
      replyToSender: threadContext.senderLabel,
      replyToSenderId: threadContext.senderId,
    };
  } else {
    replyContext = replyToEventId
      ? await resolveReplyContext({ roomId, eventId: replyToEventId })
      : undefined;
  }
  const replySenderAllowed =
    !replyContext?.replyToSenderId || isRoomContextSenderAllowed(replyContext.replyToSenderId);
  const roomInfo = isRoom ? await getRoomInfo(roomId) : undefined;
  const roomName = roomInfo?.name;
  const envelopeFrom = isDirectMessage ? senderName : (roomName ?? roomId);
  const textWithId = `${bodyText}\n[matrix event id: ${messageId} room: ${roomId}]`;
  const storePath = resolveStorePathImpl(cfg.session?.store, {
    agentId: _route.agentId,
  });
  const buildEnvelope = createChannelInboundEnvelopeBuilderImpl({ cfg, route: _route });
  const sharedDmNoticeSessionKey = threadTarget
    ? _route.mainSessionKey || _route.sessionKey
    : _route.sessionKey;
  const sharedDmContextNotice = isDirectMessage
    ? hasExplicitSessionBinding
      ? null
      : resolveMatrixSharedDmContextNotice({
          storePath,
          sessionKey: sharedDmNoticeSessionKey,
          roomId,
          accountId: _route.accountId,
          dmSessionScope,
          sentRooms: sharedDmContextNoticeRooms,
          logVerboseMessage,
        })
    : null;
  const body = buildEnvelope({
    channel: "Matrix",
    from: envelopeFrom,
    timestamp: eventTs ?? undefined,
    body: textWithId,
  });
  const groupSystemPrompt = normalizeOptionalString(roomConfig?.systemPrompt);
  const quoteHidden = Boolean(
    replyContext &&
    !evaluateSupplementalContextVisibility({
      mode: contextVisibilityMode,
      kind: "quote",
      senderAllowed: replySenderAllowed,
    }).include,
  );
  // Thread and conversation bindings finalize the Matrix session after the access preflight.
  const channelIngress = await resolveMessageIngress(
    {
      agentId: _route.agentId,
      sessionKey: _route.sessionKey,
      messageId,
      inboundEventKind: "user_request",
    },
    {
      kind: isDirectMessage ? "direct" : "channel",
      id: roomId,
      threadId: threadTarget,
    },
  );
  const ctxPayload = core.channel.inbound.buildContext({
    channelIngress,
    channel: "matrix",
    contextVisibility: contextVisibilityMode,
    finalize: finalizeInboundContext,
    supplemental: {
      quote: replyContext
        ? {
            id: threadTarget ? undefined : (replyToEventId ?? undefined),
            body: replyContext.replyToBody,
            sender: replyContext.replyToSender,
            senderAllowed: replySenderAllowed,
          }
        : undefined,
      thread: {
        starterBody: threadContext?.threadStarterBody,
        senderAllowed: threadContext ? true : undefined,
      },
      groupSystemPrompt: isRoom ? groupSystemPrompt : undefined,
    },
    media: await toInboundMediaFactsWithMetadata(
      media
        ? [
            {
              path: media.path,
              url: media.path,
              contentType: media.contentType,
              transcribed: preflightAudioTranscript !== undefined,
            },
          ]
        : undefined,
    ),
    messageId,
    timestamp: eventTs ?? undefined,
    from: isDirectMessage ? `matrix:${senderId}` : `matrix:channel:${roomId}`,
    sender: {
      id: senderId,
      name: senderName,
      username: senderId.split(":")[0]?.replace(/^@/, ""),
    },
    conversation: {
      kind: isDirectMessage ? "direct" : "channel",
      id: roomId,
      label: envelopeFrom,
      nativeChannelId: roomId,
      threadId: threadTarget,
    },
    route: {
      agentId: _route.agentId,
      dmScope: _route.dmScope,
      accountId: _route.accountId,
      routeSessionKey: _route.sessionKey,
      parentSessionKey:
        threadTarget && _route.matchedBy !== "binding.channel" ? _route.mainSessionKey : undefined,
    },
    reply: {
      to: `room:${roomId}`,
      replyToId: threadTarget ? undefined : (replyToEventId ?? undefined),
      messageThreadId: threadTarget,
      nativeChannelId: roomId,
    },
    message: {
      body,
      rawBody: bodyText,
      commandBody: commandBodyText,
      bodyForAgent: bodyText,
      inboundHistory: inboundHistory && inboundHistory.length > 0 ? inboundHistory : undefined,
    },
    sessionTranscript: { historyLimit: isRoom ? historyLimit : 0 },
    access: {
      ...(isRoom
        ? {
            mentions: {
              canDetectMention: true,
              wasMentioned,
              requireMention: shouldRequireMention,
            },
          }
        : {}),
      commands: {
        authorized: commandAuthorized,
      },
    },
    extra: {
      GroupSubject: isRoom ? (roomName ?? roomId) : undefined,
      GroupId: isRoom ? roomId : undefined,
      ...locationPayload?.context,
      CommandSource: "text" as const,
      NativeDirectUserId: isDirectMessage ? senderId : undefined,
    },
  });
  if (quoteHidden) {
    logVerboseMessage(`matrix: drop reply context (mode=${contextVisibilityMode})`);
  }

  const preview = truncateUtf16Safe(bodyText, 200).replace(/\n/g, "\\n");
  logVerboseMessage(`matrix inbound: room=${roomId} from=${senderId} preview="${preview}"`);

  const replyTarget = ctxPayload.To;
  if (!replyTarget) {
    runtime.error?.("matrix: missing reply target");
    return null;
  }

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
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention,
      }),
    );
  if (shouldAckReaction() && messageId) {
    loadMatrixSendModule()
      .then(({ reactMatrixMessage }) => reactMatrixMessage(roomId, messageId, ackReaction, client))
      .catch((err: unknown) => {
        logVerboseMessage(`matrix react failed for room ${roomId}: ${String(err)}`);
      });
  }

  if (messageId) {
    loadMatrixSendModule()
      .then(({ sendReadReceiptMatrix }) => sendReadReceiptMatrix(roomId, messageId, client))
      .catch((err: unknown) => {
        logVerboseMessage(
          `matrix: read receipt failed room=${roomId} id=${messageId}: ${String(err)}`,
        );
      });
  }

  return {
    replyToEventId,
    threadTarget,
    storePath,
    ctxPayload,
    replyTarget,
    sharedDmContextNotice,
  };
}
