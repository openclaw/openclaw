import {
  MessageInjectionPolicyMismatchError,
  MessageInjectionTargetUnavailableError,
} from "../../auto-reply/reply/message-injection-authority.js";
import {
  prepareReplyToolAuthority,
  type ReplyToolAuthorityNarrow,
} from "../../auto-reply/reply/reply-tool-authority.js";
import type { ReplyToolAuthorityInput } from "../../auto-reply/reply/reply-tool-authority.types.js";
import { readChannelSourceTurnId } from "../../auto-reply/reply/source-turn-id.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { withSessionTranscriptQuestionAnswers } from "../../config/sessions/session-transcript-read-fence.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import type {
  EmbeddedRunToolAuthorityBinding,
  ReplyToolAuthorityOverlay,
  ReplyToolAuthorityRequester,
} from "../../sessions/session-controller.contracts.js";
import {
  assertSessionControllerOperation,
  readSessionControllerOperationState,
  recordOperationBackendRunId,
} from "../../sessions/session-controller.state.js";
import { createReplyTurnParticipants } from "../../sessions/session-controller.tool-authority.js";
import {
  readAdmittedRunOperatorAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../admitted-run-context.js";
import { getControllerEmbeddedAttachment } from "../embedded-agent-runner/run-state.js";
import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import { captureRequesterOrigin, hasSameRequesterOrigin } from "../requester-origin.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import {
  bindReplyQueueInputAdapter,
  type ReplyQueueInputAdapter,
  bindReplyToolAuthorityCallerRead,
  captureReplyToolAuthorityCallerBinding,
  createAgentQuestionAnswerAuthority,
  prepareReplyToolAuthorityCallerRead,
  registerAgentHarnessQuestionAnswerAuthority,
  withAgentQuestionAnswerAuthority,
} from "./host-private-capabilities.js";
import type { AgentHarnessAttemptParamsV2 } from "./types.js";

type ToolAuthorityAttempt = Pick<
  AgentHarnessAttemptParamsV2,
  | Exclude<
      keyof ReplyToolAuthorityInput["run"],
      "model" | "runtimePolicySessionKey" | "elevatedLevel" | "traceAuthorized"
    >
  | "modelId"
  | "sandboxSessionKey"
  | "messageChannel"
  | "toolsAllow"
  | "disableTools"
  | "forceRestartSafeTools"
  | "forceCodeModeTools"
  | "runId"
  | "abortSignal"
  | "sessionTarget"
  | "toolAuthorityFingerprint"
  | "userTurnTranscriptRecorder"
> & { hostCapabilities?: AgentHarnessAttemptParamsV2["hostCapabilities"] };

/** Execution-only: policy preparation must finish before authority reaches a publisher. */
export async function withPreparedEmbeddedRunToolAuthority<T, Attempt extends ToolAuthorityAttempt>(
  internal: Pick<
    EmbeddedRunAttemptInternalParams,
    | "admittedRunContext"
    | "replyOperation"
    | "sessionPersistence"
    | "trigger"
    | "bindWatchdogAttempt"
    | "joinObservation"
  > & { queueInputAdapter?: ReplyQueueInputAdapter },
  attempt: Attempt,
  narrow: ReplyToolAuthorityNarrow | undefined,
  run: (
    prepared: Attempt &
      Pick<AgentHarnessAttemptParamsV2, "replyOperation" | "toolAuthorityFingerprint">,
  ) => Promise<T>,
): Promise<T> {
  return await withSessionTurn(
    {
      sessionKey: attempt.sessionKey,
      sessionId: attempt.sessionId,
      agentId: attempt.agentId,
      storePath:
        attempt.sessionTarget?.storePath ??
        (attempt.config
          ? resolveSessionStorePathCore(attempt.config.session?.store, { agentId: attempt.agentId })
          : undefined),
      replyOperation: internal.replyOperation,
      abortSignal: attempt.abortSignal,
      detached: internal.sessionPersistence === "detached",
    },
    (replyOperation, abortSignal) =>
      withPreparedEmbeddedRunToolAuthorityOwned(
        { ...internal, replyOperation },
        { ...attempt, abortSignal },
        narrow,
        run,
      ),
  );
}

async function withPreparedEmbeddedRunToolAuthorityOwned<T, Attempt extends ToolAuthorityAttempt>(
  internal: Parameters<typeof withPreparedEmbeddedRunToolAuthority>[0],
  attempt: Attempt,
  narrow: ReplyToolAuthorityNarrow | undefined,
  run: Parameters<typeof withPreparedEmbeddedRunToolAuthority<T, Attempt>>[3],
): Promise<T> {
  const admitted = internal.admittedRunContext;
  const instance = admitted.operationalRunInstance;
  const assertAdmitted = resolveAdmittedRunActiveAssertion(admitted, attempt.abortSignal);
  const inherited = getGatewayToolCallerIdentity();
  const source = inherited?.operationalRunInstance === instance ? inherited : undefined;
  const { sessionId, sessionKey, sessionFile, agentId, runId } = attempt;
  const sourceTurnId = readChannelSourceTurnId(internal) ?? runId;
  const queueInputAdapter = internal.queueInputAdapter ?? "legacy-question-category";
  const operatorAuthority = readAdmittedRunOperatorAuthority(admitted);
  const requesterOrigin = captureRequesterOrigin({
    requesterOrigin: attempt.requesterOrigin,
    sessionKey,
    operatorProfileId: operatorAuthority?.profileId,
    messageProvider: attempt.messageProvider,
    messageChannel: attempt.messageChannel,
    agentAccountId: attempt.agentAccountId,
    chatType: attempt.chatType,
    conversationId: attempt.conversationId,
    messageThreadId: attempt.messageThreadId,
    groupId: attempt.groupId,
    groupChannel: attempt.groupChannel,
    groupSpace: attempt.groupSpace,
    senderId: attempt.senderId,
    senderName: attempt.senderName,
    senderUsername: attempt.senderUsername,
    senderE164: attempt.senderE164,
  });
  const route = { provider: attempt.provider, model: attempt.modelId };
  // Maintenance borrows an operation for cancellation, not its injection snapshot.
  const turn = internal.replyOperation;
  const turnState = readSessionControllerOperationState(turn);
  const ownsDirectPolicy = turnState?.turnKind === "direct" && internal.trigger !== "memory";
  let operation =
    attempt.toolAuthorityFingerprint || (ownsDirectPolicy && turn?.toolAuthorityFingerprint)
      ? turn
      : undefined;
  const assertHostActive = attempt.hostCapabilities?.assertActive;
  let live = true;
  // Preserve the complete admitted snapshot, but bind its hash and projection
  // only after hooks or native ownership have selected the actual model.
  const direct = operation
    ? undefined
    : prepareReplyToolAuthority(
        {
          originatingChannel: attempt.messageChannel,
          toolsAllow: attempt.toolsAllow,
          disableTools: attempt.disableTools,
          forceRestartSafeTools: attempt.forceRestartSafeTools,
          forceCodeModeTools: attempt.forceCodeModeTools,
          operatorAuthority,
          run: {
            ...attempt,
            model: attempt.modelId,
            elevatedLevel: attempt.bashElevated?.defaultLevel,
            runtimePolicySessionKey: attempt.sandboxSessionKey,
            traceAuthorized: false,
            spawnedBy: attempt.spawnedBy ?? undefined,
            senderId: attempt.senderId ?? undefined,
            senderName: attempt.senderName ?? undefined,
            senderUsername: attempt.senderUsername ?? undefined,
            senderE164: attempt.senderE164 ?? undefined,
            groupId: attempt.groupId ?? undefined,
            groupChannel: attempt.groupChannel ?? undefined,
            groupSpace: attempt.groupSpace ?? undefined,
          },
        },
        narrow,
        undefined,
        internal.joinObservation,
      );
  let fingerprint: string | undefined;
  let releaseAttemptSnapshot: (() => void) | undefined;
  try {
    assertActive();
    if (turn && turnState && ownsDirectPolicy && !turn.toolAuthorityFingerprint && direct) {
      releaseAttemptSnapshot = await turnState.bindAttemptToolAuthoritySnapshot(direct);
      operation = turn;
      assertActive();
    }
    fingerprint = operation
      ? await operation.bindToolAuthorityRouteAsync(route)
      : await direct?.fingerprintAsync();
    assertActive();
    if (turn) {
      // Correlate the admitted attempt before tool construction; attachment and authority stay separate.
      recordOperationBackendRunId(turn, runId);
    }
  } catch (error) {
    releaseAttemptSnapshot?.();
    direct?.close();
    throw error;
  }
  const personalToolParticipants = operation
    ? operation.personalToolParticipants
    : createReplyTurnParticipants(direct?.personalToolOwner);
  function assertActive() {
    if (
      !live ||
      !assertAdmitted ||
      admitted.operationalRunInstance !== instance ||
      instance.runId !== runId
    ) {
      throw new Error("embedded tool authority is no longer active");
    }
    assertAdmitted();
    if (turn) {
      assertSessionControllerOperation(turn);
    }
    assertHostActive?.();
    if (
      (source && (source.agentId !== agentId || source.sessionKey !== sessionKey)) ||
      (source?.workerTurnClaim &&
        (source.workerTurnClaim.sessionId !== sessionId ||
          source.workerTurnClaim.runId !== runId ||
          !source.receiptAuthority)) ||
      source?.receiptAuthority?.() === false ||
      (source?.gatewayContextResolver && !source.gatewayContextResolver())
    ) {
      throw new Error("embedded tool authority lost its source execution claim");
    }
  }
  const assertReplyActive = () => {
    assertActive();
    operatorAuthority?.assertCurrent();
    if (
      operation &&
      (operation.toolAuthorityRoute?.provider !== route.provider ||
        operation.toolAuthorityRoute.model !== route.model ||
        operation.toolAuthorityFingerprint !== fingerprint)
    ) {
      throw new Error("reply authority is no longer active");
    }
  };
  let registered = false;
  const watchdogAttempt = turn
    ? turn.watchdog.attachAttempt({
        assertCurrent: () => {
          if (!assertAdmitted) {
            throw new Error("Attempt admission retired");
          }
          assertAdmitted();
          assertSessionControllerOperation(turn);
        },
      })
    : undefined;
  if (watchdogAttempt) {
    internal.bindWatchdogAttempt?.(watchdogAttempt);
  }
  const { hostCapabilities, userTurnTranscriptRecorder } = attempt;
  // Retained authority assertions share this scope, but do not own the run payload.
  let executeAttempt: (() => Promise<T>) | undefined = run.bind(undefined, {
    ...attempt,
    replyOperation: turn,
    toolAuthorityFingerprint: fingerprint,
  });
  const runPrepared = () =>
    withSessionTranscriptQuestionAnswers(
      userTurnTranscriptRecorder,
      assertReplyActive,
      (admitTranscriptAnswer) => {
        const questionAuthority = sessionKey
          ? createAgentQuestionAnswerAuthority({
              sessionKey,
              requesterProfileId: operatorAuthority?.profileId,
              fingerprint,
              prepareCaller: async (caller) =>
                prepareReplyToolAuthorityCallerRead(
                  operation?.projectToolAuthorityFingerprintAsync ?? direct?.projectAsync,
                  caller,
                  fingerprint,
                  route,
                  assertReplyActive,
                ),
              project: (caller) =>
                operation
                  ? operation.projectToolAuthorityFingerprint(caller)
                  : direct?.project(caller, route),
              assertActive: assertReplyActive,
              admitTranscriptAnswer,
            })
          : undefined;
        if (hostCapabilities && questionAuthority) {
          registerAgentHarnessQuestionAnswerAuthority(hostCapabilities, questionAuthority);
        }
        return withAgentQuestionAnswerAuthority(questionAuthority, () => {
          if (!executeAttempt) {
            throw new Error("embedded attempt execution is closed");
          }
          return executeAttempt();
        });
      },
    );

  try {
    if (!agentId || !sessionKey) {
      return await runPrepared();
    }
    return await withGatewayToolCallerIdentity(
      {
        agentId,
        sessionKey,
        operationalRunInstance: instance,
        personalToolParticipants,
        watchdogAttempt,
        requesterOrigin,
        receiptAuthority: assertReplyActive,
        embeddedRunToolAuthorityBinding: (registration) => {
          const { handle } = registration;
          const assertRegistered = (assertSource = assertActive) => {
            assertSource();
            if (handle.runId !== runId || handle.toolAuthorityFingerprint !== fingerprint) {
              throw new Error("embedded tool authority handle changed");
            }
          };
          assertRegistered();
          if (
            registration.sessionId !== sessionId ||
            registration.sessionKey !== sessionKey ||
            registration.sessionFile !== sessionFile ||
            (registration.agentId !== undefined && registration.agentId !== agentId) ||
            handle.runId !== runId ||
            !fingerprint ||
            handle.toolAuthorityFingerprint !== fingerprint
          ) {
            throw new Error("embedded tool authority registration does not match its attempt");
          }
          const ownsOperation = () =>
            !operation ||
            (getControllerEmbeddedAttachment(operation)?.handle === handle &&
              operation.toolAuthorityRoute?.provider === route.provider &&
              operation.toolAuthorityRoute.model === route.model);
          registered = true;
          const project = (caller: ReplyToolAuthorityOverlay | ReplyToolAuthorityRequester) => {
            assertRegistered();
            if (!ownsOperation()) {
              return undefined;
            }
            const projected =
              "requesterOrigin" in caller
                ? operation
                  ? operation.projectRequesterToolAuthorityFingerprint?.(caller)
                  : direct?.projectRequester(caller, route)
                : operation
                  ? operation.projectToolAuthorityFingerprint(caller)
                  : direct?.project(caller, route);
            assertRegistered();
            return ownsOperation() ? projected : undefined;
          };
          const projectAsync = async (
            caller: ReplyToolAuthorityOverlay | ReplyToolAuthorityRequester,
          ) => {
            assertRegistered();
            if (!ownsOperation()) {
              return undefined;
            }
            const prepared =
              !operation && direct
                ? await prepareReplyToolAuthorityCallerRead(
                    "requesterOrigin" in caller
                      ? direct.projectRequesterAsync
                      : direct.projectAsync,
                    caller,
                    fingerprint,
                    route,
                    assertRegistered,
                  )
                : undefined;
            if (prepared) {
              await prepared.prepareCurrent();
              assertRegistered();
              return ownsOperation() ? fingerprint : undefined;
            }
            if (!operation && direct) {
              const current = await direct.fingerprintAsync(route);
              assertRegistered();
              if (!ownsOperation() || current !== fingerprint) {
                return undefined;
              }
            }
            const projected =
              "requesterOrigin" in caller
                ? operation
                  ? await operation.projectRequesterToolAuthorityFingerprintAsync?.(caller)
                  : await direct?.projectRequesterAsync(caller, route)
                : operation
                  ? await operation.projectToolAuthorityFingerprintAsync(caller)
                  : await direct?.projectAsync(caller, route);
            assertRegistered();
            return ownsOperation() ? projected : undefined;
          };
          // The published handle owns either the reply snapshot or this exact
          // attempt snapshot. A lifecycle-only turn cannot lend its policy.
          bindReplyToolAuthorityCallerRead(
            projectAsync,
            (caller, expected, _requestedRoute, assertCaller) => {
              const assertPreparedOwner = () => {
                assertCaller();
                assertRegistered();
                if (!ownsOperation() || fingerprint !== expected) {
                  throw new MessageInjectionTargetUnavailableError(
                    "Embedded attempt authority changed during steering",
                  );
                }
              };
              assertPreparedOwner();
              if (!operation && caller && "kind" in caller) {
                const selected = direct?.requestedRoute;
                if (
                  selected &&
                  (selected.provider !== caller.selectedRoute.provider ||
                    selected.model !== caller.selectedRoute.model)
                ) {
                  throw new MessageInjectionPolicyMismatchError(
                    "model-fallback-changed",
                    "The selected model changed before steering",
                  );
                }
              }
              return captureReplyToolAuthorityCallerBinding(
                operation?.projectToolAuthorityFingerprintAsync ?? direct?.projectAsync,
                caller,
                expected,
                route,
                assertPreparedOwner,
              );
            },
          );
          const binding: ReturnType<EmbeddedRunToolAuthorityBinding> = {
            watchdogAttempt,
            personalToolParticipants,
            operation: turn,
            ...(!turn ? { detached: true as const } : {}),
            source: operation ? "reply" : "attempt",
            sourceTurnId,
            get requesterPrincipalKey() {
              return operation?.requesterPrincipalKey ?? direct?.requesterPrincipalKey;
            },
            assertRegistrationActive: () => assertRegistered(assertReplyActive),
            assertActive: () => {
              assertRegistered();
              if (!ownsOperation()) {
                throw new Error("embedded reply authority is no longer active");
              }
            },
            acceptsRequesterOrigin: (incoming) => {
              assertRegistered();
              return Boolean(
                ownsOperation() &&
                requesterOrigin &&
                hasSameRequesterOrigin(requesterOrigin, incoming),
              );
            },
            project,
            projectAsync,
            projectRequester: project,
            projectRequesterAsync: projectAsync,
          };
          return bindReplyQueueInputAdapter(binding, queueInputAdapter);
        },
      },
      runPrepared,
    );
  } finally {
    // Retained ALS callbacks do not extend the attempt's authority.
    live = false;
    executeAttempt = undefined;
    if (!registered) {
      watchdogAttempt?.close();
    }
    releaseAttemptSnapshot?.();
    if (!operation) {
      direct?.close();
      personalToolParticipants?.close();
    }
  }
}
