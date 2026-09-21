import path from "node:path";
import {
  cancelPendingAgentQuestionForSession,
  claimPendingAgentQuestionAnswer,
  detectAndLoadAgentHarnessPromptImages,
  embeddedAgentLog,
  formatErrorMessage,
  resolveAttemptFsWorkspaceOnly,
  setActiveEmbeddedRun,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { prepareAgentWorkspaceAttachments } from "openclaw/plugin-sdk/agent-workspace-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-local-roots";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { hasPromptImageInput } from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { terminateCodexBackgroundTerminals } from "./attempt-client-cleanup.js";
import { isTerminalTurnStatus } from "./attempt-notifications.js";
import {
  CodexSteeringAcceptedUnconfirmedError,
  createCodexSteeringQueue,
  type CodexSteeringQueueOptions,
} from "./attempt-steering.js";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import { createCodexNativeMcpAppResultDetailsPreparer } from "./native-mcp-app.js";
import { canonicalizeNativeProgressCardInput } from "./plan-compaction-state.js";
import { isJsonObject } from "./protocol.js";
import { readRecentCodexRateLimits } from "./rate-limit-cache.js";
import { readBoundedCodexRemoteWorkspaceFile } from "./remote-workspace-media.js";
import { mapCodexAppServerRemoteWorkspacePath } from "./remote-workspace-path.js";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import type { CodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { CodexStartedTurn } from "./run-attempt-turn-request.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import {
  codexTranscriptMirrorRuntime,
  createCodexAppServerUserMessagePersistenceNotifier,
  mirrorPromptAtTurnStartBestEffort,
} from "./transcript-mirror.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";
import { buildCodexUserInput } from "./user-input.js";
import { buildResolvedCodexUserPromptMessage } from "./user-prompt-message.js";

export function activateCodexAttemptTurn(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  lifecycle: CodexAttemptLifecycleController,
  notifications: CodexAttemptNotificationController,
  { turn, upstreamUserText }: CodexStartedTurn,
) {
  const {
    prompt,
    state: resourceState,
    projectorRef,
    trajectoryRecorder,
    pendingNativePreToolUseFailures,
  } = resources;
  const { context, turnState } = prompt;
  const { runtime, attemptTools, hookContext } = context;
  const { connection } = runtime;
  const {
    params,
    runAbortController,
    terminalState,
    abortExplicitly,
    abortFromUpstream,
    sessionAgentId,
    contextSessionKey,
    effectiveCwd,
  } = connection;
  const { dynamicToolParams, compactionPlanState, computerContextEpoch, toolBridge } = attemptTools;
  const {
    state,
    completion,
    userInputBridgeRef,
    steeringQueueRef,
    deadlines,
    noteProgress,
    completeTurn,
    interruptTurn,
  } = turnRuntime;
  const { emitExecutionPhaseOnce, emitLifecycleStart, maybeAnnounceFastModeAutoOff } = lifecycle;
  const { enqueueNotification } = notifications;
  const activeTurnId = turn.turn.id;
  const { thread } = resourceState;
  const runtimeModelSelection =
    thread.preserveNativeModel && thread.model && thread.modelProvider
      ? { provider: thread.modelProvider, model: thread.model }
      : undefined;
  // Native preparation may replace the cached model. Attribute this turn to its
  // ready thread, not the outer route or the pre-resume binding snapshot.
  const projectionParams = runtimeModelSelection
    ? {
        ...dynamicToolParams,
        provider: runtimeModelSelection.provider,
        modelId: runtimeModelSelection.model,
        model: {
          ...dynamicToolParams.model,
          id: runtimeModelSelection.model,
          name: runtimeModelSelection.model,
          provider: runtimeModelSelection.provider,
        },
      }
    : dynamicToolParams;
  const hostPrepareReplyMedia = params.hostCapabilities.prepareReplyMedia;
  const remoteWorkspaceRoot = connection.appServer.remoteWorkspaceRoot;
  const replyMediaClient = resourceState.client;
  const prepareReplyMedia =
    hostPrepareReplyMedia && remoteWorkspaceRoot
      ? async (
          content:
            | { kind: "attempt"; attempt: EmbeddedRunAttemptResult }
            | { kind: "payload"; payload: ReplyPayload },
          transferSignal?: AbortSignal,
        ) =>
          hostPrepareReplyMedia({
            ...content,
            workspaceRoot: remoteWorkspaceRoot,
            signal: runAbortController.signal,
            readWorkspaceFile: async (relativePath, { maxBytes, signal }) => {
              connection.assertCurrent();
              const file = await readBoundedCodexRemoteWorkspaceFile({
                client: replyMediaClient,
                path: mapCodexAppServerRemoteWorkspacePath({
                  value: path.resolve(params.workspaceDir, relativePath),
                  localWorkspaceRoot: params.workspaceDir,
                  remoteWorkspaceRoot,
                }),
                workspaceRoot: remoteWorkspaceRoot,
                maxBytes,
                signal: transferSignal ? AbortSignal.any([signal, transferSignal]) : signal,
                timeoutMs: connection.appServer.requestTimeoutMs,
              });
              connection.assertCurrent();
              return Buffer.from(file.dataBase64, "base64");
            },
          })
      : undefined;
  const progressCardTool = toolBridge.availableTools.find((tool) => tool.name === "progress_card");
  let nativePlanUpdateOrdinal = 0;
  const prepareNativeMcpAppResultDetails = createCodexNativeMcpAppResultDetailsPreparer({
    client: resourceState.client,
    threadId: resourceState.thread.threadId,
    attempt: dynamicToolParams,
  });
  const streamState = { eventEmitted: false, needsTerminalSnapshot: false };
  projectorRef.current = new CodexAppServerEventProjector(
    {
      ...projectionParams,
      onAgentEvent: (event) => {
        if (event.stream === "assistant" && typeof event.data.delta === "string") {
          streamState.eventEmitted = true;
          streamState.needsTerminalSnapshot ||= event.data.replaceable === true;
        }
        return dynamicToolParams.onAgentEvent?.(event);
      },
    },
    resourceState.thread.threadId,
    activeTurnId,
    {
      agentHookContext: hookContext,
      initialContextTokens: connection.mutable.startupContextTokens,
      nativePostToolUseRelayEnabled:
        resourceState.nativeHookRelay?.allowedEvents.includes("post_tool_use") === true &&
        resourceState.nativeHookRelay.shouldRelayEvent("post_tool_use"),
      asyncUserMessageAllowed:
        params.disableTools !== true &&
        (params.toolsAllow === undefined ||
          toolBridge.availableTools.some((tool) => tool.name === "message")),
      onAsyncDelivery: async (delivery) => {
        return await codexTranscriptMirrorRuntime.deliverAsyncMessageBestEffort({
          params:
            prepareReplyMedia && projectionParams.onBlockReply
              ? {
                  ...projectionParams,
                  onBlockReply: async (payload, options) => {
                    const prepared = await prepareReplyMedia({ kind: "payload", payload });
                    if (prepared.kind !== "payload") {
                      throw new Error("Reply media preparation returned the wrong result kind");
                    }
                    await projectionParams.onBlockReply?.(prepared.payload, options);
                  },
                }
              : projectionParams,
          cwd: effectiveCwd,
          threadId: resourceState.thread.threadId,
          turnId: activeTurnId,
          ...delivery,
        });
      },
      readRecentRateLimits: () => readRecentCodexRateLimits(resourceState.client),
      runAbortSignal: runAbortController.signal,
      remoteWorkspaceRoot: connection.appServer.remoteWorkspaceRoot,
      remoteWorkspaceRequestTimeoutMs: connection.appServer.requestTimeoutMs,
      readRemoteWorkspaceFile: ({ path: remotePath, maxBytes, signal, timeoutMs }) =>
        readBoundedCodexRemoteWorkspaceFile({
          client: resourceState.client,
          path: remotePath,
          maxBytes,
          signal,
          timeoutMs,
        }),
      trajectoryRecorder,
      resolveDynamicToolResultContentSource: toolBridge.resultContentSourceForTool,
      onNativeToolResultRecorded: maybeAnnounceFastModeAutoOff,
      ...(progressCardTool
        ? {
            onNativePlanUpdate: async (update: {
              markdown?: string;
              steps: Array<{
                step: string;
                status: "pending" | "in_progress" | "completed";
              }>;
            }) => {
              nativePlanUpdateOrdinal += 1;
              try {
                const input = canonicalizeNativeProgressCardInput(update);
                await progressCardTool.execute(
                  `codex-native-plan:${activeTurnId}:${nativePlanUpdateOrdinal}`,
                  input,
                  runAbortController.signal,
                );
              } catch (error) {
                embeddedAgentLog.warn("failed to persist native Codex plan to progress card", {
                  runId: params.runId,
                  threadId: resourceState.thread.threadId,
                  error: formatErrorMessage(error),
                });
              }
            },
          }
        : {}),
      ...(prepareNativeMcpAppResultDetails ? { prepareNativeMcpAppResultDetails } : {}),
      upstreamUserText,
      onContextCompacted: async () => {
        computerContextEpoch.value += 1;
        delete computerContextEpoch.frameToolCallId;
        delete computerContextEpoch.frameImageIdentity;
        try {
          await compactionPlanState.restore({
            client: resourceState.client,
            threadId: resourceState.thread.threadId,
            timeoutMs: connection.appServer.requestTimeoutMs,
            signal: runAbortController.signal,
          });
        } catch (error) {
          embeddedAgentLog.warn("failed to restore Codex plan state after compaction", {
            runId: params.runId,
            threadId: resourceState.thread.threadId,
            error: formatErrorMessage(error),
          });
        }
      },
    },
  );
  const activeProjector = projectorRef.current;
  let activationFailed = false;
  const abortListener = () => {
    state.abortCleanup = interruptTurn(activeTurnId).then(async (confirmed) => {
      if (
        !activationFailed &&
        !terminalState.explicitCancellationObserved &&
        !state.permissionChangeRestart &&
        !state.timeout
      ) {
        return;
      }
      if (!confirmed) {
        throw new Error(
          state.permissionChangeRestart
            ? "Permission change could not confirm the previous Codex turn stopped."
            : "Codex cancellation could not confirm the turn stopped; background terminals may still be running.",
        );
      }
      if (resources.nativeProcessAuthority) {
        await resources.nativeProcessAuthority.cancelTurn(
          resourceState.client,
          resourceState.thread.threadId,
          activeTurnId,
        );
      } else {
        await terminateCodexBackgroundTerminals(
          resourceState.client,
          resourceState.thread.threadId,
        );
      }
      if (state.permissionChangeRestart) {
        state.permissionChangeRestart = "confirmed";
      }
    });
    void state.abortCleanup.then(completeTurn, (error: unknown) => {
      embeddedAgentLog.warn("codex app-server cancellation cleanup failed", { error });
      completeTurn();
    });
  };
  const notifyUserMessagePersisted = createCodexAppServerUserMessagePersistenceNotifier(params);
  const bindProjection = async (promptMirrorPromise: Promise<void>) => {
    state.activeLocalProjections += 1;
    try {
      if (resourceState.turnRoute) {
        try {
          // Bind receipt ownership immediately; ordered projection still waits for its user row.
          await Promise.race([
            resourceState.turnRoute.bindTurn(activeTurnId, {
              beforeNotifications: promptMirrorPromise,
            }),
            completion,
          ]);
        } catch (error) {
          if (!state.terminalTurnNotificationQueued && !runAbortController.signal.aborted) {
            throw error;
          }
          await Promise.race([resourceState.turnRoute.drain(), completion]);
          if (!state.completed) {
            throw error;
          }
        }
      } else {
        await Promise.race([promptMirrorPromise, completion]);
      }
      if (!state.completed && isTerminalTurnStatus(turn.turn.status)) {
        if (!isJsonObject(turn.turn)) {
          throw new Error("Codex turn completion payload is not a JSON object");
        }
        await enqueueNotification(
          {
            method: "turn/completed",
            params: {
              threadId: resourceState.thread.threadId,
              turnId: activeTurnId,
              turn: turn.turn,
            },
          },
          { threadId: resourceState.thread.threadId, turnId: activeTurnId },
        );
      }
    } finally {
      state.activeLocalProjections -= 1;
    }
  };
  const assertSteeringActive = () => {
    connection.assertCurrent();
    runAbortController.signal.throwIfAborted();
    if (state.completed || state.terminalTurnNotificationQueued) {
      throw new Error("codex app-server turn is no longer accepting steering");
    }
  };
  const workspaceOnly = resolveAttemptFsWorkspaceOnly({ config: params.config, sessionAgentId });
  const imageContext = {
    workspaceDir: connection.effectiveWorkspace,
    agentWorkspaceDir: params.workspaceDir,
    model: params.model,
    config: params.config,
    workspaceOnly,
    localRoots: workspaceOnly
      ? undefined
      : getAgentScopedMediaLocalRoots(params.config ?? {}, sessionAgentId),
    sandbox:
      connection.sandbox?.enabled && connection.sandbox.fsBridge
        ? { root: connection.sandbox.workspaceDir, bridge: connection.sandbox.fsBridge }
        : undefined,
  };
  const activeSteeringQueue = createCodexSteeringQueue({
    client: resourceState.client,
    threadId: resourceState.thread.threadId,
    turnId: activeTurnId,
    requestTimeoutMs: connection.appServer.requestTimeoutMs,
    signal: runAbortController.signal,
    assertActive: assertSteeringActive,
    prepareMessage: async (text, options, assertMessageCurrent) => {
      const attachmentNote = await prepareAgentWorkspaceAttachments({
        workspaceDir: params.workspaceDir,
        turn: {
          config: params.config,
          media: options.media,
          timeoutMs: params.timeoutMs,
          abortSignal: runAbortController.signal,
          userTurnTranscriptRecorder: options.userTurnTranscriptRecorder,
        },
        assertCurrent: assertMessageCurrent,
      });
      const result = await detectAndLoadAgentHarnessPromptImages({
        ...imageContext,
        prompt: text,
        existingImages: options.images,
        imageOrder: options.imageOrder,
        media: options.media,
        userTurnTranscriptRecorder: options.userTurnTranscriptRecorder,
      });
      if (result.failedMediaCount) {
        throw new Error(
          `failed to hydrate ${result.failedMediaCount} structured image attachment(s) for Codex steering`,
        );
      }
      const source = await buildResolvedCodexUserPromptMessage({
        ...params,
        prompt: text,
        transcriptPrompt: text,
        userTurnTranscriptRecorder: options.userTurnTranscriptRecorder,
      });
      return {
        input: buildCodexUserInput(
          attachmentNote ? `${text}\n\n${attachmentNote}` : text,
          result.images,
        ),
        message: {
          ...source,
          role: "user",
          content: result.images.length ? [{ type: "text", text }, ...result.images] : text,
          ...(result.images.length
            ? {
                __openclaw: {
                  ...asOptionalRecord(Reflect.get(source, "__openclaw")),
                  mediaImageBlockFactIndexes: result.imageFactIndexes,
                },
              }
            : {}),
        },
      };
    },
    beforeSubmit: async (items) => {
      // Commit preceding answers and user custody before Codex can act on the
      // steer. Its acknowledgment and user-message echo can both arrive later.
      const transcriptItems = items.filter(
        (item) =>
          item.isInboundUserMessage === true || item.userTurnTranscriptRecorder !== undefined,
      );
      if (transcriptItems.length === 0) {
        return;
      }
      await projectionReady;
      await notifications.drainNotificationQueue();
      assertSteeringActive();
      const messages = activeProjector.buildSteeringTranscriptPrefix();
      if (params.sessionTarget && messages.length > 0) {
        await codexTranscriptMirrorRuntime.mirror({
          assertCurrent: assertSteeringActive,
          agentId: sessionAgentId,
          sessionKey: contextSessionKey,
          sessionId: params.sessionId,
          storePath: params.sessionTarget.storePath,
          cwd: effectiveCwd,
          messages,
          idempotencyScope: `codex-app-server:${resourceState.thread.threadId}`,
          runId: params.runId,
          runMirrorIdentityPrefix: `${activeTurnId}:`,
          config: params.config,
        });
        assertSteeringActive();
        activeProjector.markSteeringTranscriptPersisted();
      }
      for (const item of transcriptItems) {
        const recorder = item.userTurnTranscriptRecorder;
        if (!recorder) {
          continue;
        }
        assertSteeringActive();
        await recorder.persistApproved();
        if (!recorder.hasPersisted()) {
          throw new Error("Codex steering requires a persisted user turn before submission");
        }
      }
    },
  });
  steeringQueueRef.current = activeSteeringQueue;
  type InputAuthority = NonNullable<
    Parameters<typeof claimPendingAgentQuestionAnswer>[0]["authority"]
  >;
  const injectionGuard = (assertCurrent?: () => void) => () => {
    assertCurrent?.();
    assertSteeringActive();
    return true;
  };
  const claimPendingUserInputAnswer = async (
    text: string,
    optionsLocal?: CodexSteeringQueueOptions,
    assertCurrent?: () => void,
    authorityKind: InputAuthority["kind"] = assertCurrent ? "source-bound" : "run",
  ) => {
    if (optionsLocal?.isInboundUserMessage !== true || hasPromptImageInput(optionsLocal)) {
      return false;
    }
    assertSteeringActive();
    return await claimPendingAgentQuestionAnswer({
      sessionKey: params.sessionKey ?? params.sessionId,
      text,
      authority: { kind: authorityKind, assertCurrent: injectionGuard(assertCurrent) },
      sourceRecorder: optionsLocal.userTurnTranscriptRecorder,
      // Older supported hosts use the ordinary-question callback. Current hosts
      // prefer the recorder owner so staged secret inputs commit before consumption.
      persist: optionsLocal.userTurnTranscriptRecorder
        ? async () => {
            await optionsLocal.userTurnTranscriptRecorder?.persistApproved();
          }
        : undefined,
    });
  };
  const cancelPendingUserInput = (
    resolvedBy: string,
    assertCurrent?: () => void,
    authorityKind: InputAuthority["kind"] = assertCurrent ? "source-bound" : "run",
  ) =>
    cancelPendingAgentQuestionForSession({
      sessionKey: params.sessionKey ?? params.sessionId,
      resolvedBy,
      authority: { kind: authorityKind, assertCurrent: injectionGuard(assertCurrent) },
    });
  // V1 retains backend-only authority; V2 requires a host assertion.
  const queueMessage = async (
    text: string,
    optionsLocal?: CodexSteeringQueueOptions,
    assertCurrent?: () => void,
    authorityKind: InputAuthority["kind"] = assertCurrent ? "source-bound" : "run",
  ) => {
    const canClaim = injectionGuard(assertCurrent);
    if (await claimPendingUserInputAnswer(text, optionsLocal, assertCurrent, authorityKind)) {
      // A question claim is already consumption. Closing the run during its
      // response must not turn that answer into a rejected, replayable steer.
      optionsLocal?.onQueueAccepted?.(true);
      return undefined;
    }
    if (optionsLocal?.isInboundUserMessage === true && hasPromptImageInput(optionsLocal)) {
      assertSteeringActive();
      try {
        await cancelPendingUserInput("image-reply", assertCurrent, authorityKind);
      } catch (error) {
        canClaim();
        if (error instanceof Error && error.name === "QuestionDispatchRefusedError") {
          throw error;
        }
        // Cleanup failure must not drop the user's image turn.
        embeddedAgentLog.warn("failed to cancel codex gateway question before image steering", {
          error,
        });
      }
    }
    try {
      await activeSteeringQueue.queue(text, optionsLocal, injectionGuard(assertCurrent));
    } catch (error) {
      if (error instanceof CodexSteeringAcceptedUnconfirmedError) {
        return {
          transcriptCommit: "unconfirmed" as const,
          errorMessage: formatErrorMessage(error),
        };
      }
      throw error;
    }
    return undefined;
  };
  const messageInjection = {
    version: 2 as const,
    isAvailable: () =>
      !state.completed &&
      !state.terminalTurnNotificationQueued &&
      !runAbortController.signal.aborted,
    queueMessage,
    claimPendingUserInputAnswer,
    cancelPendingUserInput,
  };
  const handle = {
    kind: "embedded" as const,
    runId: params.runId,
    startedAtMs: params.startedAtMs,
    toolAuthorityFingerprint: params.toolAuthorityFingerprint,
    permissionChangeOwner: params.permissionChange?.owner,
    applyPermissionMode: async (
      mode: NonNullable<typeof params.permissionMode> | null,
      revokeApprovals: () => void,
    ) => {
      if (
        !params.permissionChange ||
        terminalState.terminalOutcomeFrozen ||
        params.abortSignal?.aborted ||
        (!state.permissionChangeRestart && (state.completed || runAbortController.signal.aborted))
      ) {
        return false;
      }
      const applied = params.permissionChange.request(mode);
      state.permissionChangeRestart ??= "requested";
      // A policy replacement cancels this native turn, not the admitted outer
      // run. Its successor must be prepared only after native stop and cleanup.
      runAbortController.abort("permission-change");
      revokeApprovals();
      return await applied;
    },
    claimPendingUserInputAnswer,
    cancelPendingUserInput,
    queueMessage,
    messageInjection,
    messageInjectionV2: messageInjection,
    isStreaming: () => !state.completed && !runAbortController.signal.aborted,
    isAborted: () => runAbortController.signal.aborted,
    isStopped: () => state.completed || runAbortController.signal.aborted,
    ownsLiveness: () =>
      deadlines.ownsExecutionWait() &&
      resourceState.turnRoute?.signal.aborted === false &&
      !state.completed &&
      !state.terminalTurnNotificationQueued &&
      state.activeAppServerTurnRequests === 0 &&
      state.activeLocalProjections === 0,
    isAbortable: () =>
      !terminalState.terminalOutcomeFrozen || terminalState.sharedAbortAllowedAfterTerminalOutcome,
    isCompacting: () => projectorRef.current?.isCompacting() ?? false,
    // queueMessage resolves only after Codex echoes the steered userMessage completion.
    // Gateway-owned turns rely on that boundary before finalizing adoption.
    supportsTranscriptCommitWait: true,
    supportsQueueMessageImages: params.model.input.includes("image"),
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
    cancel: () => abortExplicitly("cancelled"),
    abort: () => abortExplicitly("aborted"),
  };
  const freezeRunTerminalOutcome = () => {
    if (terminalState.terminalOutcomeFrozen) {
      return;
    }
    terminalState.terminalOutcomeFrozen = true;
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
  };
  // Return cleanup ownership before callbacks or backend publication can fail.
  const projectionReady = Promise.resolve().then(async () => {
    runAbortController.signal.addEventListener("abort", abortListener, { once: true });
    if (runAbortController.signal.aborted) {
      abortListener();
    }
    try {
      emitExecutionPhaseOnce("turn_accepted", { phase: "turn_accepted" });
      userInputBridgeRef.current = createCodexUserInputBridge({
        paramsForRun: params,
        onOrdinaryResponse: (response) => activeProjector.recordUserInputResponse(response),
        threadId: resourceState.thread.threadId,
        turnId: activeTurnId,
        signal: runAbortController.signal,
      });
      trajectoryRecorder?.recordEvent("prompt.submitted", {
        threadId: resourceState.thread.threadId,
        turnId: activeTurnId,
        prompt: turnState.codexTurnPromptText,
        imagesCount: params.images?.length ?? 0,
      });
      if (isTerminalTurnStatus(turn.turn.status)) {
        activeProjector.settlement.terminalReceipt = turn.turn;
        state.terminalTurnNotificationQueued = true;
        deadlines.beginSettlement(Date.now());
      }
      emitLifecycleStart({ provider: projectionParams.provider, model: projectionParams.modelId });
      noteProgress("turn:start");
      for (const failure of pendingNativePreToolUseFailures.splice(0)) {
        activeProjector.recordNativeToolPreToolUseFailure(failure);
      }
      if (
        thread.preserveNativeModel !== true &&
        thread.connectionScope !== "supervision" &&
        !params.expectedSessionRuntimeOwnership
      ) {
        const route = resourceState.turnRoute;
        params.registerPluginRuntimeRefreshConsumer?.(
          () =>
            resourceState.turnRoute === route &&
            route?.signal.aborted === false &&
            turnRuntime.turnIdRef.current === activeTurnId &&
            !state.completed &&
            !state.terminalTurnNotificationQueued &&
            !runAbortController.signal.aborted,
        );
      }
      params.replyOperation?.attachBackend(handle);
      setActiveEmbeddedRun(
        params.sessionId,
        handle,
        params.sessionKey,
        params.sessionFile,
        sessionAgentId,
      );
      if (
        !runAbortController.signal.aborted &&
        params.permissionChange &&
        !params.permissionChange.applied()
      ) {
        state.permissionChangeRestart = "requested";
        runAbortController.abort("permission-change");
      }
      await bindProjection(
        mirrorPromptAtTurnStartBestEffort({
          params,
          agentId: sessionAgentId,
          notifyUserMessagePersisted,
          sessionKey: contextSessionKey,
          cwd: effectiveCwd,
          threadId: resourceState.thread.threadId,
          turnId: activeTurnId,
          upstreamUserText,
        }),
      );
    } catch (error) {
      activationFailed = true;
      runAbortController.abort(error);
      throw error;
    }
  });
  return {
    activeTurnId,
    activeProjector,
    runtimeModelSelection,
    streamState,
    prepareReplyMedia,
    handle,
    freezeRunTerminalOutcome,
    notifyUserMessagePersisted,
    abortListener,
    ready: projectionReady,
  };
}

export type CodexAttemptActiveTurn = Awaited<ReturnType<typeof activateCodexAttemptTurn>>;
