import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  hasFinalInboundReplyDispatch,
  resolveInboundReplyDispatchCounts,
} from "openclaw/plugin-sdk/channel-inbound";
import type { ChannelIngressMonitorLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  logTypingFailure,
} from "openclaw/plugin-sdk/channel-outbound";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-local-roots";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { prepareMatrixReplyPayload } from "../../outbound.js";
import { isPollEventType } from "../poll-types.js";
import type { LocationMessageEventContent } from "../sdk.js";
import { RelationType } from "../send/types.js";
import { normalizeMatrixUserId } from "./allowlist.js";
import { createMatrixEventContextResolver } from "./event-context.js";
import { resolveMatrixInboundContext } from "./handler-context.js";
import { createMatrixDraftController } from "./handler-draft-controller.js";
import {
  hasBundledMatrixReplacementRelation,
  markTrackedRoomIfFirst,
  shouldDeferMatrixAudioPreflightForRoomIngress,
} from "./handler-helpers.js";
import {
  resolveMatrixIngressAccess,
  type MatrixIngressAccessParams,
} from "./handler-ingress-access.js";
import { resolveMatrixIngressContent } from "./handler-ingress-content.js";
import { createMatrixReplyDispatcher } from "./handler-reply-dispatcher.js";
import { loadMatrixSendModule } from "./handler-runtime.js";
import { createMatrixHandlerState } from "./handler-state.js";
import type { MatrixHandlerRuntimeConfig, MatrixMonitorHandlerParams } from "./handler-types.js";
import { resolveMatrixLocation, type MatrixLocationPayload } from "./location.js";
import { createRoomHistoryTracker } from "./room-history.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";
import { isMatrixVerificationRoomMessage } from "./verification-utils.js";

// Core emits this stable error code across the plugin boundary; Matrix cannot import the
// core lifecycle module that owns it. Keep the notice actionable or replay will dead-end.
const SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE = "SESSION_RESTART_RECOVERY_TOMBSTONE";
const RESTART_RECOVERY_TOMBSTONE_NOTICE =
  "This session ended during gateway restart recovery and cannot accept more messages. Send /new or /reset to start a replacement session.";

export function createMatrixRoomMessageHandler(params: MatrixMonitorHandlerParams) {
  const {
    client,
    core,
    cfg: startupConfig,
    accountId,
    runtime,
    logger,
    logVerboseMessage,
    allowFromResolvedEntries = [],
    groupAllowFromResolvedEntries = [],
    configuredBotUserIds = new Set<string>(),
    replyToMode,
    streaming,
    previewToolProgressEnabled,
    blockStreamingEnabled,
    historyLimit,
    directTracker,
    getMemberDisplayName,
  } = params;
  const handlerConfig: MatrixHandlerRuntimeConfig = {
    ...params,
    allowFromResolvedEntries,
    groupAllowFromResolvedEntries,
    configuredBotUserIds,
  };
  const handlerState = createMatrixHandlerState({
    core,
    accountId,
    runtime,
    allowFromResolvedEntries,
    groupAllowFromResolvedEntries,
  });
  const resolveThreadContext = createMatrixEventContextResolver({
    kind: "thread",
    client,
    getMemberDisplayName,
    logVerboseMessage,
  });
  const resolveReplyContext = createMatrixEventContextResolver({
    kind: "reply",
    client,
    getMemberDisplayName,
    logVerboseMessage,
  });
  const roomHistoryTracker = createRoomHistoryTracker();
  const roomIngressQueue = new KeyedAsyncQueue();
  const sharedDmContextNoticeRooms = new Set<string>();

  return async (
    roomId: string,
    event: MatrixRawEvent,
    lifecycle: ChannelIngressMonitorLifecycle,
  ) => {
    const eventId = typeof event.event_id === "string" ? event.event_id.trim() : "";
    let draftControllerRef: Awaited<ReturnType<typeof createMatrixDraftController>> | undefined;
    try {
      const eventType = event.type;
      if (eventType === EventType.RoomMessageEncrypted) {
        // Encrypted payloads are decrypted by durable ingress before delivery.
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
      const readIngressPrefix = async () => {
        const selfUserId = await client.getUserId();
        if (senderId === selfUserId) {
          return undefined;
        }
        const content = locationContent;

        if (
          eventType === EventType.RoomMessage &&
          isMatrixVerificationRoomMessage({
            msgtype: content.msgtype,
            body: content.body,
          })
        ) {
          logVerboseMessage(`matrix: skip verification/system room message room=${roomId}`);
          return undefined;
        }

        const locationPayload: MatrixLocationPayload | null = resolveMatrixLocation({
          eventType,
          content,
        });

        const relates = content["m.relates_to"];
        if (relates && "rel_type" in relates && relates.rel_type === RelationType.Replace) {
          return undefined;
        }
        if (hasBundledMatrixReplacementRelation(event)) {
          return undefined;
        }
        const directMessage = await directTracker.isDirectMessage({
          roomId,
          senderId,
          selfUserId,
        });
        return { content, isDirectMessage: directMessage, locationPayload, selfUserId };
      };
      const ingressContext = {
        handler: handlerConfig,
        roomId,
        event,
        eventTs: eventTs ?? undefined,
        senderId,
        roomHistoryTracker,
      };
      const continueIngress = async (paramsLocal: MatrixIngressAccessParams) => {
        const access = await resolveMatrixIngressAccess({
          ...ingressContext,
          params: paramsLocal,
          isReactionEvent,
          readStoreAllowFrom: handlerState.readStoreAllowFrom,
          shouldSendPairingReply: handlerState.shouldSendPairingReply,
          resolveLiveAccountAllowlists: handlerState.resolveLiveAccountAllowlists,
        });
        if (!access) {
          return undefined;
        }
        return await resolveMatrixIngressContent({
          ...ingressContext,
          params: paramsLocal,
          access,
          eventType,
          isPollEvent,
          resolveThreadContext,
        });
      };
      const ingressResult =
        historyLimit > 0
          ? await roomIngressQueue.enqueue(roomId, async () => {
              const prefix = await readIngressPrefix();
              if (!prefix) {
                return undefined;
              }
              if (prefix.isDirectMessage) {
                return { deferredPrefix: prefix } as const;
              }
              const result = await continueIngress({
                ...prefix,
                audioPreflightMode: shouldDeferMatrixAudioPreflightForRoomIngress({
                  content: prefix.content,
                  cfg: startupConfig,
                })
                  ? "defer"
                  : "run",
              });
              return result && "deferredPrefix" in result
                ? { deferredPrefix: result.deferredPrefix }
                : { ingressResult: result };
            })
          : undefined;
      const resolvedIngressResult =
        historyLimit > 0
          ? ingressResult?.deferredPrefix
            ? await continueIngress(ingressResult.deferredPrefix)
            : ingressResult?.ingressResult
          : await (async () => {
              const prefix = await readIngressPrefix();
              if (!prefix) {
                return undefined;
              }
              return await continueIngress(prefix);
            })();
      if (!resolvedIngressResult) {
        return;
      }
      if ("deferredPrefix" in resolvedIngressResult) {
        return;
      }

      const {
        cfg,
        liveDmAllowFrom,
        route: _route,
        roomConfig,
        isDirectMessage,
        isRoom,
        bodyText,
        messageId,
        triggerSnapshot,
        threadRootId,
        thread,
        botLoopProtection,
      } = resolvedIngressResult;

      // Keep the per-room ingress gate focused on ordering-sensitive state updates.
      // Prompt/session enrichment below can run concurrently after the history snapshot is fixed.
      const inboundContext = await resolveMatrixInboundContext({
        ...ingressContext,
        ingress: resolvedIngressResult,
        resolveThreadContext,
        resolveReplyContext,
        sharedDmContextNoticeRooms,
      });
      if (!inboundContext) {
        return;
      }
      const {
        replyToEventId,
        threadTarget,
        storePath,
        ctxPayload,
        replyTarget,
        sharedDmContextNotice,
      } = inboundContext;
      const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, _route.agentId);
      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg,
        agentId: _route.agentId,
        channel: "matrix",
        accountId: _route.accountId,
      });
      const sendTyping = async (isTyping: boolean) => {
        const { sendTypingMatrix } = await loadMatrixSendModule();
        await sendTypingMatrix(roomId, isTyping, { client });
      };
      const onTypingError = (action: "start" | "stop", error: unknown) => {
        logTypingFailure({
          log: logVerboseMessage,
          channel: "matrix",
          action,
          target: roomId,
          error,
        });
      };
      const typingCallbacks = createTypingCallbacks({
        start: () => sendTyping(true),
        stop: () => sendTyping(false),
        onStartError: (err) => onTypingError("start", err),
        onStopError: (err) => onTypingError("stop", err),
      });
      // Matrix drafts are provider-visible before outbound modifiers run. Keep them off when a
      // hook can rewrite or cancel so the original payload cannot escape the delivery gate.
      const hookRunner = getGlobalHookRunner();
      const allowProviderPreview = !(
        (hookRunner?.hasHooks("reply_payload_sending") ?? false) ||
        (hookRunner?.hasHooks("message_sending") ?? false)
      );
      const draftController = await createMatrixDraftController({
        streaming: allowProviderPreview ? streaming : "off",
        previewToolProgressEnabled: allowProviderPreview && previewToolProgressEnabled,
        replyToMode,
        messageId,
        threadTarget,
        accountConfig: params.accountConfig,
        cfg,
        accountId: _route.accountId,
        roomId,
        client,
        logVerboseMessage,
      });
      const { draftStream } = draftController;
      draftControllerRef = draftController;
      const replyDispatcher = createMatrixReplyDispatcher({
        cfg,
        prefixOptions,
        humanDelay: resolveHumanDelayConfig(cfg, _route.agentId),
        typingCallbacks,
        streaming,
        draftStream,
        draftController,
        client,
        roomId,
        runtime,
        replyToMode,
        threadTarget,
        replyToEventId: replyToEventId ?? undefined,
        accountId: _route.accountId,
        mediaLocalRoots,
        logVerboseMessage,
      });
      const { deliverReply, onReplyError, turnDispatcherOptions } = replyDispatcher;
      const pinnedMainDmOwner = isDirectMessage
        ? resolvePinnedMainDmOwnerFromAllowlist({
            dmScope: cfg.session?.dmScope,
            allowFrom: liveDmAllowFrom,
            normalizeEntry: normalizeMatrixUserId,
          })
        : null;

      const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
        route: _route,
        sessionKey: _route.sessionKey,
      });
      const turnResultPromise = core.channel.inbound.run({
        channel: "matrix",
        accountId: _route.accountId,
        raw: event,
        turnAdoptionLifecycle: lifecycle,
        adapter: {
          ingest: () => ({
            id: messageId,
            rawText: bodyText,
            textForAgent: ctxPayload.BodyForAgent,
            textForCommands: ctxPayload.CommandBody,
            raw: event,
          }),
          resolveTurn: () => ({
            cfg,
            channel: "matrix",
            accountId: _route.accountId,
            route: { agentId: _route.agentId, sessionKey: _route.sessionKey },
            ctxPayload,
            botLoopProtection,
            record: {
              updateLastRoute: isDirectMessage
                ? {
                    sessionKey: inboundLastRouteSessionKey,
                    channel: "matrix",
                    to: `room:${roomId}`,
                    accountId: _route.accountId,
                    mainDmOwnerPin:
                      inboundLastRouteSessionKey === _route.mainSessionKey && pinnedMainDmOwner
                        ? {
                            ownerRecipient: pinnedMainDmOwner,
                            senderRecipient: normalizeMatrixUserId(senderId),
                            onSkip: ({
                              ownerRecipient,
                              senderRecipient,
                            }: {
                              ownerRecipient: string;
                              senderRecipient: string;
                            }) => {
                              logVerboseMessage(
                                `matrix: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                              );
                            },
                          }
                        : undefined,
                  }
                : undefined,
              onRecordError: (err) => {
                logger.warn("failed updating session meta", {
                  error: String(err),
                  storePath,
                  sessionKey: ctxPayload.SessionKey ?? _route.sessionKey,
                });
              },
            },
            afterRecord: async () => {
              if (
                sharedDmContextNotice &&
                markTrackedRoomIfFirst(sharedDmContextNoticeRooms, roomId)
              ) {
                try {
                  await client.sendMessage(roomId, {
                    msgtype: "m.notice",
                    body: sharedDmContextNotice,
                  });
                } catch (err) {
                  logVerboseMessage(
                    `matrix: failed sending shared DM session notice room=${roomId}: ${String(err)}`,
                  );
                }
              }
            },
            delivery: {
              observeMessageSent: true,
              preparePayload: prepareMatrixReplyPayload,
              durable: replyDispatcher.durable,
              deliver: deliverReply,
              onError: (err, info) => onReplyError(err, info as Parameters<typeof onReplyError>[1]),
            },
            dispatcherOptions: {
              ...turnDispatcherOptions,
              onSettled: () => draftController.cancelProgressDraft(),
            },
            replyOptions: {
              skillFilter: roomConfig?.skills,
              // Preserve explicit block streaming with draft previews: drafts update the live
              // block, while block deliveries finalize completed blocks as separate events.
              disableBlockStreaming: !blockStreamingEnabled,
              onPartialReply: draftStream
                ? (payload) => draftController.onPartialReply(payload.text ?? "")
                : undefined,
              // Reset draft boundary bookkeeping on assistant message
              // boundaries so post-tool blocks stream from a fresh
              // cumulative payload (payload.text resets upstream).
              onAssistantMessageStart: draftStream
                ? () => {
                    draftController.resetDraftBlockOffsets();
                    draftController.beginAssistantMessage();
                    return false;
                  }
                : undefined,
              onQueuedFollowupAdmitted: draftStream
                ? draftController.resetDraftDeliveryState
                : undefined,
              ...draftController.buildPreviewToolProgressReplyOptions(),
              onObservedReplyDelivery: draftStream
                ? () => draftController.previewLifecycle.observeDelivery({ visibleReplySent: true })
                : undefined,
              onModelSelected,
            },
          }),
        },
      });
      let turnResult: Awaited<typeof turnResultPromise>;
      try {
        turnResult = await turnResultPromise;
      } catch (err) {
        if (extractErrorCode(err) !== SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE) {
          throw err;
        }
        try {
          const { sendMessageMatrix } = await loadMatrixSendModule();
          await sendMessageMatrix(roomId, RESTART_RECOVERY_TOMBSTONE_NOTICE, {
            cfg,
            client,
            accountId: _route.accountId,
            replyToId: threadTarget || replyToMode === "off" ? undefined : messageId,
            fallbackReplyToId: threadTarget,
            threadId: threadTarget,
            deliveryQueueId: `matrix:restart-recovery-tombstone:${_route.accountId}:${roomId}:${eventId}`,
            deliveryPartIndex: 0,
            deliveryPartCount: 1,
            extraContent: { msgtype: "m.notice" },
          });
        } catch (noticeError) {
          runtime.error?.(
            `matrix: failed completing restart-recovery tombstone notice room=${roomId} id=${eventId || "unknown"}: ${String(noticeError)}`,
          );
          throw noticeError;
        }
        return;
      }
      if (!turnResult.dispatched) {
        return;
      }
      const { dispatchResult } = turnResult;
      const { queuedFinal } = dispatchResult;
      const failedDeliveryKind = draftController.previewLifecycle.finalFailed
        ? "final"
        : !queuedFinal && replyDispatcher.nonFinalReplyDeliveryFailed()
          ? "non-final"
          : undefined;
      if (failedDeliveryKind) {
        logVerboseMessage(
          `matrix: ${failedDeliveryKind} reply delivery failed room=${roomId} id=${messageId}; turn already adopted`,
        );
        return;
      }
      // Advance the per-agent watermark now that the reply succeeded (or no reply was needed).
      // Only advance to the snapshot position — messages added during async processing remain
      // visible for the next trigger.
      if (isRoom && triggerSnapshot) {
        roomHistoryTracker.consumeHistory(
          _route.agentId,
          roomId,
          triggerSnapshot,
          messageId,
          threadRootId ? thread.threadId : undefined,
        );
      }
      if (!hasFinalInboundReplyDispatch(dispatchResult)) {
        return;
      }
      const finalCount = resolveInboundReplyDispatchCounts(dispatchResult).final;
      logVerboseMessage(
        `matrix: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
      );
    } catch (err) {
      const draftController = draftControllerRef;
      if (draftController?.draftStream?.eventId()) {
        // A Matrix-accepted preview is the only visible reply after an abort.
        draftController.previewLifecycle.retainPreview();
      }
      runtime.error?.(`matrix handler failed: ${String(err)}`);
      throw err;
    } finally {
      // Stop the draft stream timer so partial drafts don't leak if the
      // model run throws or times out mid-stream.
      const draftStream = draftControllerRef?.draftStream;
      if (draftStream) {
        await draftStream.stop().catch(() => undefined);
        await draftControllerRef?.previewLifecycle.cleanup();
        await draftStream.cleanupPending();
      }
    }
  };
}
