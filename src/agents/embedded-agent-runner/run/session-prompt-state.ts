import {
  runWithoutOwnedSessionTranscriptWrites,
  withOwnedSessionTranscriptWrites,
  type SessionTranscriptWriterFence,
} from "../../../config/sessions/transcript-write-context.js";
import type { ContextEngineSessionTarget } from "../../../context-engine/types.js";
import { registerAgentRunContext } from "../../../infra/agent-run-registry.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { adoptExecRequestSession } from "../../../infra/exec-request-context.js";
import { getUserTurnTranscriptAdmissionOwner } from "../../../sessions/user-turn-transcript-admission.js";
import type { AgentRunSessionTarget } from "../../run-session-target.types.js";
import type { CustomMessage } from "../../sessions/messages.js";
import { appendSessionTranscriptNote } from "../../sessions/session-manager-write-admission.js";
import { TOOL_FAILURE_INSTRUCTION } from "../../tool-outcome-instructions.js";
import type { AcceptedCompactionSuccessor } from "../compaction-successor.js";
import { log } from "../logger.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./internal-params.js";
import {
  buildContextEngineCompactionSessionTarget,
  prepareInitialSessionWriter,
} from "./session-bootstrap.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const CONTINUATION_PROMPT =
  "Continue the current task from the existing transcript, preserving completed work. If an action was interrupted, inspect its state before deciding whether to retry it. Do not restart the task or repeat completed actions.";

type ActivePrompt = {
  override?: string;
  persisted: boolean;
  internal: boolean;
};

export async function createEmbeddedRunSessionPromptState(input: {
  runParams: RunEmbeddedAgentParamsWithSessionFile;
  /** The selected runtime carries retry instructions separately from the original user turn. */
  reusePersistedUserTurn?: boolean;
  sessionAgentId: string;
  resolvedSessionKey: string;
  lifecycleGeneration: NonNullable<RunEmbeddedAgentParamsWithSessionFile["lifecycleGeneration"]>;
  onInterrupt: (reason: Error) => void;
}) {
  const { runParams: params, sessionAgentId, resolvedSessionKey, lifecycleGeneration } = input;
  let activeSessionId = params.sessionId;
  let activeSessionFile = params.sessionFile;
  let activeSessionTarget: ContextEngineSessionTarget | undefined =
    buildContextEngineCompactionSessionTarget({
      agentId: params.agentId ?? sessionAgentId,
      config: params.config,
      sessionFile: activeSessionFile,
      sessionId: activeSessionId,
      sessionKey: resolvedSessionKey,
      sessionTarget: params.sessionTarget,
    });
  const expectedWriterRunId = params.sessionTarget?.expectedWriterRunId?.trim();
  const existingWriterFence: SessionTranscriptWriterFence | undefined = expectedWriterRunId
    ? {
        expectedLifecycleRevision: params.sessionTarget?.expectedLifecycleRevision,
        expectedWriterRunId,
      }
    : undefined;
  const initialOwner = await prepareInitialSessionWriter({
    runParams: params,
    target: activeSessionTarget,
    onInterrupt: input.onInterrupt,
  });
  const initialWriter = initialOwner?.writer;
  const initialTarget = initialWriter ? { ...activeSessionTarget } : undefined;
  let sessionTargetAdopted = false;
  let committedCompactionSuccessor: AcceptedCompactionSuccessor | undefined;
  // Only retries after this run mutates its transcript may wait for deferred projection work.
  // Fresh attempts retain the projection owner's bounded, retryable failure contract.
  let settleOwnedTranscriptProjection = false;
  let suppressNextUserMessagePersistence = params.suppressNextUserMessagePersistence ?? false;
  let basePromptOverride: string | undefined;
  let continuation: EmbeddedRunAttemptParams["continuation"];
  let compactionContinuationInstruction: string | undefined;
  const activePrompt: ActivePrompt = {
    get override() {
      const instruction = compactionContinuationInstruction;
      return instruction && basePromptOverride?.trim()
        ? `${basePromptOverride}\n\n${instruction}`
        : (instruction ?? basePromptOverride);
    },
    persisted: suppressNextUserMessagePersistence,
    internal: false,
  };

  const notifySessionIdChanged = (previousSessionId: string) => {
    // Update host provenance before callbacks can close the exact run owner.
    registerAgentRunContext(params.runId, { sessionId: activeSessionId, lifecycleGeneration });
    adoptExecRequestSession({ runId: params.runId, previousSessionId, sessionId: activeSessionId });
    params.replyOperation?.updateSessionId(activeSessionId);
    params.onSessionIdChanged?.(activeSessionId);
  };
  const adoptSessionId = (nextSessionId: string | undefined) => {
    if (!nextSessionId || nextSessionId === activeSessionId) {
      return;
    }
    const previousSessionId = activeSessionId;
    activeSessionId = nextSessionId;
    notifySessionIdChanged(previousSessionId);
  };
  const capturePreparedCompactionTarget = (
    target: Pick<AcceptedCompactionSuccessor, "sessionId" | "sessionFile" | "sessionTarget">,
  ) => {
    activeSessionId = target.sessionId;
    activeSessionFile = target.sessionFile;
    activeSessionTarget = target.sessionTarget;
    sessionTargetAdopted = true;
  };
  const recordCommittedCompactionSuccessor = (accepted: AcceptedCompactionSuccessor) => {
    // Commit-edge bookkeeping only: observers may cancel before the patch promise
    // returns, so neither notification callbacks nor another await belongs here.
    committedCompactionSuccessor = accepted;
    capturePreparedCompactionTarget(accepted);
  };
  const notifyCompactionSessionAdopted = (previousSessionId: string | undefined) => {
    if (previousSessionId && previousSessionId !== activeSessionId) {
      notifySessionIdChanged(previousSessionId);
    }
  };
  // Internal control prompts are model-only context, never operator-authored transcript turns.
  const activateInternalPrompt = (prompt: string) => {
    basePromptOverride = prompt;
    Object.assign(activePrompt, { persisted: true, internal: true });
    suppressNextUserMessagePersistence = true;
  };
  // An outer model fallback starts a fresh invocation, but its retry instructions
  // cannot recapture the original user projection after that turn has dispatched.
  const dispatchedFallback =
    params.modelRoutingProvenance?.stage === "fallback" &&
    input.reusePersistedUserTurn !== true &&
    params.userTurnTranscriptRecorder !== undefined &&
    getUserTurnTranscriptAdmissionOwner(params.userTurnTranscriptRecorder)?.sentToProvider() ===
      true;
  if (params.pluginRuntimeRefreshContinuation || dispatchedFallback) {
    activateInternalPrompt(params.prompt);
  }
  const activateCompactionContinuation = (instruction: string) => {
    compactionContinuationInstruction = instruction;
    activateInternalPrompt(basePromptOverride ?? "");
  };
  const clearCompactionContinuation = () => (compactionContinuationInstruction = undefined);
  const onUserMessagePersisted: NonNullable<
    RunEmbeddedAgentParamsWithSessionFile["onUserMessagePersisted"]
  > = (message) => {
    const messageMetadata = message as {
      __openclaw?: { beforeAgentRunBlocked?: unknown };
    };
    const blockedBeforeAgentRun = messageMetadata["__openclaw"]?.beforeAgentRunBlocked;
    const markCurrentUserMessagePersisted = () => {
      activePrompt.persisted = true;
      params.onUserMessagePersisted?.(message);
    };
    const recorder = params.userTurnTranscriptRecorder;
    if (!recorder) {
      markCurrentUserMessagePersisted();
      return;
    }
    const markWhenPersisted = (persisted: { message?: unknown } | undefined) => {
      if (persisted?.message || recorder.hasPersisted()) {
        markCurrentUserMessagePersisted();
      }
    };
    const canonicalPersistence =
      blockedBeforeAgentRun !== undefined
        ? recorder.persistBlocked(message)
        : recorder.persistApproved();
    const observedPersistence = canonicalPersistence
      .then(markWhenPersisted)
      .catch((persistError: unknown) => {
        log.warn(
          `failed to persist canonical ${blockedBeforeAgentRun !== undefined ? "blocked " : ""}embedded user turn transcript: ${formatErrorMessage(persistError)}`,
        );
      });
    recorder.markRuntimePersistencePending(observedPersistence);
  };
  const waitForCurrentUserMessagePersistence = async () => {
    if (params.userTurnTranscriptRecorder?.hasRuntimePersistencePending() === true) {
      await params.userTurnTranscriptRecorder.waitForRuntimePersistence();
    }
  };

  return {
    [Symbol.asyncDispose]: async () => await initialOwner?.close(),
    get sessionId() {
      return activeSessionId;
    },
    get sessionFile() {
      return activeSessionFile;
    },
    set sessionFile(value: string) {
      activeSessionFile = value;
    },
    get sessionTarget() {
      return activeSessionTarget;
    },
    set sessionTarget(value: ContextEngineSessionTarget | undefined) {
      activeSessionTarget = value;
      sessionTargetAdopted = true;
    },
    get sessionTargetAdopted() {
      return sessionTargetAdopted;
    },
    get committedCompactionSuccessor() {
      return committedCompactionSuccessor;
    },
    // Context engines receive only portable session identity. Keep the admitted
    // writer fact private while carrying it across rebased/adopted targets.
    get sessionWriterFence() {
      return existingWriterFence ?? initialWriter?.committedFence;
    },
    withSessionWriterContext: <T>(run: () => Promise<T>): Promise<T> => {
      const withContext = () =>
        initialWriter && !initialWriter.committedFence
          ? withOwnedSessionTranscriptWrites(
              {
                sessionTarget: initialTarget,
                initialWriter,
                withTranscriptWrite: initialWriter.withTranscriptWrite,
              },
              run,
            )
          : runWithoutOwnedSessionTranscriptWrites(run);
      return initialOwner ? initialOwner.run(withContext) : withContext();
    },
    recordOutputLimitNotice: async (toolCallId: string | undefined) => {
      const note: CustomMessage = {
        role: "custom",
        customType: "incomplete-tool-call",
        content:
          `Runtime notice: The tool call${toolCallId ? ` ${JSON.stringify(toolCallId.slice(0, 200))}` : ""} was cut off at the provider's output limit (max_output_tokens) and was not executed. ` +
          "Split the remaining work into smaller tool calls with shorter arguments. Earlier actions may have completed; verify their results before continuing and do not repeat completed actions.",
        display: false,
        details: { reason: "max_output_tokens", ...(toolCallId ? { toolCallId } : {}) },
        timestamp: Date.now(),
      };
      if (params.sessionManager) {
        await params.sessionManager.appendMessageAsync(note);
      } else {
        const target = activeSessionTarget;
        if (!target?.agentId || !target.sessionId || !target.sessionKey || !target.storePath) {
          throw new Error("Missing session transcript target for output-limit recovery");
        }
        await appendSessionTranscriptNote(
          {
            ...target,
            agentId: target.agentId,
            sessionId: target.sessionId,
            sessionKey: target.sessionKey,
            storePath: target.storePath,
            ...(existingWriterFence ?? initialWriter?.committedFence),
          },
          note,
          { config: params.config },
        );
      }
    },
    get activePrompt() {
      return activePrompt;
    },
    get continuation() {
      return continuation;
    },
    get suppressNextUserMessagePersistence() {
      return suppressNextUserMessagePersistence;
    },
    set suppressNextUserMessagePersistence(value: boolean) {
      suppressNextUserMessagePersistence = value;
    },
    adoptSessionId,
    capturePreparedCompactionTarget,
    recordCommittedCompactionSuccessor,
    notifyCompactionSessionAdopted,
    activateInternalPrompt,
    activateCompactionContinuation,
    clearCompactionContinuation,
    markOwnedTranscriptRetry: () => {
      settleOwnedTranscriptProjection = true;
    },
    settleOwnedTranscriptProjection: async (
      target: AgentRunSessionTarget | undefined,
      abortSignal?: AbortSignal,
    ) => {
      const sessionId = target?.sessionId ?? activeSessionId;
      // A caller's manager owns the transcript even when metadata has a durable target.
      // Waiting on that borrowed identity can block an unrelated in-memory retry.
      if (settleOwnedTranscriptProjection && !params.sessionManager && target && sessionId) {
        settleOwnedTranscriptProjection = false;
        const { waitForSessionTranscriptProjection } =
          await import("../../../config/sessions/session-transcript-reconcile.js");
        await waitForSessionTranscriptProjection({ ...target, sessionId }, abortSignal);
      }
    },
    continueFromCurrentTranscript: (options?: {
      includeToolFailureInstruction?: boolean;
      messages?: NonNullable<EmbeddedRunAttemptParams["continuation"]>["messages"];
    }) => {
      // Raw model runs load no transcript history; the original prompt is their only task context.
      if (params.modelRun === true || params.promptMode === "none") {
        return;
      }
      if (options?.messages) {
        continuation = {
          prompt: params.prompt,
          messages: [...(continuation?.messages ?? []), ...options.messages],
        };
      }
      const prompt = options?.includeToolFailureInstruction
        ? `${CONTINUATION_PROMPT} ${TOOL_FAILURE_INSTRUCTION}`
        : CONTINUATION_PROMPT;
      activateInternalPrompt(prompt);
    },
    onUserMessagePersisted,
    waitForCurrentUserMessagePersistence,
    prepareCompactedTranscriptRetry: async (assertActive: () => void) => {
      await waitForCurrentUserMessagePersistence();
      assertActive();
      settleOwnedTranscriptProjection = true;
      if (activePrompt.internal) {
        suppressNextUserMessagePersistence = activePrompt.persisted;
      } else if (activePrompt.persisted) {
        activateInternalPrompt(CONTINUATION_PROMPT);
      }
    },
  };
}
