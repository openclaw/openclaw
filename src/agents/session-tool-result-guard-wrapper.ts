import type { PrepareAssistantTranscriptMessage } from "../config/sessions/transcript-assistant-delivery.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { advanceMessageActionPrompt } from "../gateway/message-action-turn-capability.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  applyInputProvenanceToUserMessage,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import {
  attachRuntimeUserTurnTranscriptRecorder,
  takeRuntimeUserTurnTranscriptContext,
  takeRuntimeUserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript-runtime-context.js";
import {
  mergePreparedUserTurnMessageForRuntime,
  restorePreparedUserTurnOperationalMetaForRuntime,
  type PersistedUserTurnMessage,
  type UserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript.js";
import type { AssistantErrorTranscript } from "./assistant-error-transcript.js";
import { isMidTurnPrecheckAssistantError } from "./embedded-agent-runner/run/midturn-precheck.js";
import { readPersistedImageBlockFactIndexes } from "./embedded-agent-runner/run/prompt-image-metadata.js";
import {
  resolveLiveToolResultMaxChars,
  truncateToolResultMessage,
} from "./embedded-agent-runner/tool-result-truncation.js";
import { runAgentHarnessBeforeMessageWriteHook } from "./harness/hook-helpers.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "./harness/transcript-visibility.js";
import type { EmbeddedRunTrigger } from "./run-trigger.js";
import type { AgentMessage } from "./runtime/index.js";
import {
  installSessionToolResultGuard,
  type NextUserMessagePersistence,
} from "./session-tool-result-guard.js";
import { resolveMaxToolResultChars } from "./session-tool-result-guard.payload.js";
import type { SessionManager } from "./sessions/index.js";
import type {
  CompactionAppendPersistence,
  CompactionAppendPersistenceAsync,
} from "./sessions/session-compaction-persistence.js";
import { setSessionToolResultPreparer } from "./sessions/session-tool-result-preparation.js";
import { sanitizeTranscriptMessage } from "./transcript-sanitize.js";

type GuardedSessionManager = SessionManager &
  Partial<
    Pick<
      ReturnType<typeof installSessionToolResultGuard>,
      | "hasPendingToolResults"
      | "flushPendingToolResults"
      | "flushPendingToolResultsAsync"
      | "clearPendingToolResults"
      | "setNextUserMessagePersistence"
    >
  > & {
    /** Refresh the exact owning run when a caller reuses this guarded manager. */
    setTranscriptRunContext?: (options: Parameters<typeof guardSessionManager>[1]) => void;
    /** Retire only this binding after its accepted transcript writes drain. */
    clearTranscriptRunCallbacks?: () => void;
  };

function publishPersistedUserEnvelope(
  runtime: PersistedUserTurnMessage | undefined,
  persisted: PersistedUserTurnMessage,
): void {
  // Admission can freeze an unchanged input when it is already storage-canonical.
  if (!runtime || runtime === persisted || Object.isFrozen(runtime)) {
    return;
  }
  // Publish once, before model transforms. Replay must use the same envelope;
  // runtime content and symbol-carried media/steering facts remain prepared.
  const content = runtime.content;
  const imageFactIndexes = readPersistedImageBlockFactIndexes(runtime);
  for (const key of Object.keys(runtime)) {
    Reflect.deleteProperty(runtime, key);
  }
  Object.assign(runtime, persisted, { content });
  if (imageFactIndexes) {
    runtime["__openclaw"] = {
      ...runtime["__openclaw"],
      mediaImageBlockFactIndexes: imageFactIndexes,
    };
  }
}

type GuardOptions = {
  agentId?: string;
  runId?: string;
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  sessionKey?: string;
  config?: OpenClawConfig;
  contextWindowTokens?: number;
  inputProvenance?: InputProvenance;
  privateCompletion?: true;
  allowSyntheticToolResults?: boolean;
  missingToolResultText?: string;
  allowedToolNames?: Iterable<string>;
  trigger?: EmbeddedRunTrigger;
  preparedUserTurnMessage?: PersistedUserTurnMessage;
  preparedUserTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
  suppressNextUserMessagePersistence?: boolean;
  suppressTranscriptOnlyAssistantPersistence?: boolean;
  assistantErrorTranscript?: AssistantErrorTranscript;
  /** Finalization keeps transcript normalization but must not run plugin write hooks. */
  skipBeforeMessageWriteHooks?: boolean;
  onUserMessagePersisted?: (
    message: Extract<AgentMessage, { role: "user" }>,
    runtimeMessage: Extract<AgentMessage, { role: "user" }> | undefined,
  ) => void | Promise<void>;
  onUserMessagePersistenceSuppressed?: (
    message: Extract<AgentMessage, { role: "user" }>,
    runtimeMessage: Extract<AgentMessage, { role: "user" }> | undefined,
  ) => void | Promise<void>;
  onUserMessagePreparingForPersistence?: (
    message: Extract<AgentMessage, { role: "user" }>,
    recorder: UserTurnTranscriptRecorder | undefined,
    preparedMessage: PersistedUserTurnMessage | undefined,
  ) => void;
  onUserMessageBlocked?: (message: Extract<AgentMessage, { role: "user" }>) => void;
  onMessagePersisted?: (message: AgentMessage) => void | Promise<void>;
  withCompactionPersistence?: CompactionAppendPersistence;
  withCompactionPersistenceAsync?: CompactionAppendPersistenceAsync;
};

type TranscriptRunContext = ReturnType<
  NonNullable<
    NonNullable<Parameters<typeof installSessionToolResultGuard>[1]>["captureMessageContext"]
  >
> & {
  release: () => void;
  setNextUserMessagePersistence: (mode: NextUserMessagePersistence) => void;
};

function createTranscriptRunContext(
  sessionManager: SessionManager,
  {
    agentId,
    runId,
    sessionKey,
    prepareAssistantTranscriptMessage: initialPrepareAssistantTranscriptMessage,
    skipBeforeMessageWriteHooks,
    inputProvenance,
    privateCompletion,
    trigger,
    preparedUserTurnMessage,
    preparedUserTurnTranscriptRecorder: initialPreparedUserTurnTranscriptRecorder,
    suppressNextUserMessagePersistence,
    suppressTranscriptOnlyAssistantPersistence,
    assistantErrorTranscript,
    onMessagePersisted,
    onUserMessagePreparingForPersistence: initialOnUserMessagePreparingForPersistence,
    onUserMessagePersisted: initialOnUserMessagePersisted,
    onUserMessagePersistenceSuppressed: initialOnUserMessagePersistenceSuppressed,
    onUserMessageBlocked,
  }: GuardOptions = {},
  reusing = false,
): TranscriptRunContext {
  let prepareAssistantTranscriptMessage =
    trigger === "memory" ? undefined : initialPrepareAssistantTranscriptMessage;
  let pendingPreparedUserTurnMessage = preparedUserTurnMessage;
  let preparedUserTurnTranscriptRecorder = initialPreparedUserTurnTranscriptRecorder;
  let onUserMessagePreparingForPersistence = initialOnUserMessagePreparingForPersistence;
  let onUserMessagePersisted = initialOnUserMessagePersisted;
  let onUserMessagePersistenceSuppressed = initialOnUserMessagePersistenceSuppressed;
  const hidden = privateCompletion === true || trigger === "memory";
  let preparedUserReplayKey =
    preparedUserTurnTranscriptRecorder?.getPersistedMessage?.()?.idempotencyKey ===
    pendingPreparedUserTurnMessage?.idempotencyKey
      ? pendingPreparedUserTurnMessage?.idempotencyKey
      : undefined;
  const hookRunner = getGlobalHookRunner();
  let queuedUserTurnTranscriptRecorder: UserTurnTranscriptRecorder | undefined;
  const runtimeUserMessageByPersistedMessage = new WeakMap<
    AgentMessage,
    Extract<AgentMessage, { role: "user" }>
  >();
  const beforeMessageWrite = (event: { message: AgentMessage }) => {
    // Persisting a routing signal would force recovery to rewrite the whole archive to remove it.
    if (isMidTurnPrecheckAssistantError(event.message)) {
      return { block: true };
    }
    const runtimeUserMessage = runtimeUserMessageByPersistedMessage.get(event.message);
    let message = event.message;
    let changed = false;
    // Accepted source bytes already passed the plugin hook before ACK. Only
    // transcript normalization and visibility still run when the native turn consumes them.
    const skipUserWriteHook =
      skipBeforeMessageWriteHooks ||
      (message.role === "user" &&
        queuedUserTurnTranscriptRecorder?.getPendingInputMessage?.() !== undefined);
    if (
      (!skipUserWriteHook && hookRunner?.hasHooks("before_message_write")) ||
      prepareAssistantTranscriptMessage
    ) {
      const preparedMessage =
        message.role === "user"
          ? { ...message, __openclaw: { ...Reflect.get(message, "__openclaw") } }
          : undefined;
      if (
        preparedMessage &&
        (preparedMessage["__openclaw"].humanMentions !== undefined ||
          preparedMessage["__openclaw"].workContext !== undefined)
      ) {
        // Hooks may rewrite text in place; retained selections and context must
        // compare against the submitted bytes, not the already-mutated array.
        preparedMessage.content = structuredClone(preparedMessage.content);
        preparedMessage["__openclaw"].humanMentions = structuredClone(
          preparedMessage["__openclaw"].humanMentions,
        );
      }
      const next = runAgentHarnessBeforeMessageWriteHook({
        message,
        agentId,
        sessionKey,
        prepareAssistantTranscriptMessage,
        skipBeforeMessageWriteHooks: skipUserWriteHook,
      });
      if (!next) {
        runtimeUserMessageByPersistedMessage.delete(event.message);
        queuedUserTurnTranscriptRecorder?.markBlocked();
        queuedUserTurnTranscriptRecorder = undefined;
        return { block: true };
      }
      message = restorePreparedUserTurnOperationalMetaForRuntime({
        runtimeMessage: next,
        preparedMessage,
      });
      changed = true;
    }
    const sanitized = sanitizeTranscriptMessage(message);
    if (sanitized !== message) {
      message = sanitized;
      changed = true;
    }
    const projectedMessage = projectAgentHarnessTranscriptMessageForDisplay({
      hidden,
      inputProvenance,
      message,
    });
    if (projectedMessage !== message) {
      message = projectedMessage;
      changed = true;
    }
    if (message.role !== "user" && queuedUserTurnTranscriptRecorder) {
      queuedUserTurnTranscriptRecorder.markBlocked();
      queuedUserTurnTranscriptRecorder = undefined;
    }
    if (message.role === "user" && queuedUserTurnTranscriptRecorder) {
      message = attachRuntimeUserTurnTranscriptRecorder(message, queuedUserTurnTranscriptRecorder);
      queuedUserTurnTranscriptRecorder = undefined;
    }
    if (runtimeUserMessage && message.role === "user") {
      runtimeUserMessageByPersistedMessage.set(message, runtimeUserMessage);
    }
    return changed ? { message } : undefined;
  };

  const transformMessageForPersistence = (message: AgentMessage) => {
    queuedUserTurnTranscriptRecorder = undefined;
    const withProvenance = applyInputProvenanceToUserMessage(message, inputProvenance);
    const runtimeContext = takeRuntimeUserTurnTranscriptContext(message);
    // Replay may reuse the current user without appending it. Its prepared
    // metadata must not leak onto a later queued user, including staged steering.
    if (
      message.role === "user" &&
      preparedUserReplayKey !== undefined &&
      Reflect.get(runtimeContext?.message ?? message, "idempotencyKey") !== preparedUserReplayKey
    ) {
      pendingPreparedUserTurnMessage = undefined;
      context.nextUserMessagePersistence = "normal";
    }
    const prepared = runtimeContext?.message ?? pendingPreparedUserTurnMessage;
    const recorder =
      runtimeContext?.recorder ??
      (prepared !== undefined && prepared === pendingPreparedUserTurnMessage
        ? preparedUserTurnTranscriptRecorder
        : undefined);
    if (message.role === "user") {
      onUserMessagePreparingForPersistence?.(message, recorder, prepared);
    }
    const merged = mergePreparedUserTurnMessageForRuntime({
      runtimeMessage: withProvenance,
      ...(prepared ? { preparedMessage: prepared } : {}),
    });
    if (merged !== withProvenance) {
      queuedUserTurnTranscriptRecorder = recorder;
      if (!runtimeContext) {
        pendingPreparedUserTurnMessage = undefined;
      }
    }
    if (message.role === "user" && merged.role === "user") {
      // Persistence callbacks may be re-entrant. Correlate through the exact
      // transformed object instead of a mutable latest-message slot.
      runtimeUserMessageByPersistedMessage.set(merged, message);
    }
    return merged;
  };
  const context: TranscriptRunContext = {
    runId,
    assistantErrorTranscript,
    suppressTranscriptOnlyAssistantPersistence,
    nextUserMessagePersistence:
      suppressNextUserMessagePersistence && (!reusing || preparedUserReplayKey === undefined)
        ? "suppress"
        : "normal",
    beforeMessageWriteHook: beforeMessageWrite,
    transformMessageForPersistence,
    onMessagePersisted,
    onUserMessagePersisted: async (message, persistence) => {
      const runtimeMessage = runtimeUserMessageByPersistedMessage.get(message);
      runtimeUserMessageByPersistedMessage.delete(message);
      publishPersistedUserEnvelope(runtimeMessage, persistence.persistedMessage);
      const recorder = takeRuntimeUserTurnTranscriptRecorder(message);
      recorder?.markRuntimePersisted(persistence.persistedMessage, persistence.anchor, {
        appended: persistence.appended,
      });
      advanceMessageActionPrompt({
        runId,
        agentId,
        sessionKey,
        sessionId: sessionManager.getSessionId(),
        recorder,
      });
      await onUserMessagePersisted?.(persistence.persistedMessage, runtimeMessage);
    },
    onUserMessagePersistenceSuppressed: async (message) => {
      const runtimeMessage = runtimeUserMessageByPersistedMessage.get(message);
      runtimeUserMessageByPersistedMessage.delete(message);
      const recorder = takeRuntimeUserTurnTranscriptRecorder(message);
      publishPersistedUserEnvelope(
        runtimeMessage,
        recorder?.getPersistedMessage?.() ??
          preparedUserTurnTranscriptRecorder?.getPersistedMessage?.() ??
          message,
      );
      await onUserMessagePersistenceSuppressed?.(message, runtimeMessage);
    },
    onUserMessageBlocked,
    setNextUserMessagePersistence: (mode) => {
      context.nextUserMessagePersistence = mode;
    },
    release: () => {
      // Synthetic-result cleanup still needs this run's visibility and attribution.
      context.onMessagePersisted = undefined;
      context.onUserMessageBlocked = undefined;
      context.assistantErrorTranscript = undefined;
      onUserMessagePreparingForPersistence = undefined;
      onUserMessagePersisted = undefined;
      onUserMessagePersistenceSuppressed = undefined;
      prepareAssistantTranscriptMessage = undefined;
      pendingPreparedUserTurnMessage = undefined;
      preparedUserTurnTranscriptRecorder = undefined;
      preparedUserReplayKey = undefined;
      queuedUserTurnTranscriptRecorder = undefined;
    },
  };
  return context;
}

/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export function guardSessionManager(
  sessionManager: SessionManager,
  options?: GuardOptions,
): GuardedSessionManager {
  const guardedSessionManager: GuardedSessionManager = sessionManager;
  if (typeof guardedSessionManager.flushPendingToolResultsAsync === "function") {
    guardedSessionManager.setTranscriptRunContext?.(options);
    return guardedSessionManager;
  }
  const { agentId, sessionKey } = options ?? {};
  const hookRunner = getGlobalHookRunner();
  let context = createTranscriptRunContext(sessionManager, options);
  const transform = hookRunner?.hasHooks("tool_result_persist")
    ? (
        message: AgentMessage,
        meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
      ) => {
        const out = hookRunner.runToolResultPersist(
          {
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
            message,
            isSynthetic: meta.isSynthetic,
          },
          {
            agentId,
            sessionKey,
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
          },
        );
        return out?.message ?? message;
      }
    : undefined;

  const maxToolResultChars = resolveMaxToolResultChars({
    maxToolResultChars:
      typeof options?.contextWindowTokens === "number"
        ? resolveLiveToolResultMaxChars({ contextWindowTokens: options.contextWindowTokens })
        : undefined,
  });
  const guard = installSessionToolResultGuard(sessionManager, {
    sessionKey,
    agentId,
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: options?.allowSyntheticToolResults,
    missingToolResultText: options?.missingToolResultText,
    allowedToolNames: options?.allowedToolNames,
    config: options?.config,
    maxToolResultChars,
    withCompactionPersistence: options?.withCompactionPersistence,
    withCompactionPersistenceAsync: options?.withCompactionPersistenceAsync,
    captureMessageContext: () => context,
  });
  setSessionToolResultPreparer(guardedSessionManager, {
    cap: (message) => truncateToolResultMessage(message, maxToolResultChars),
  });
  guardedSessionManager.hasPendingToolResults = guard.hasPendingToolResults;
  guardedSessionManager.flushPendingToolResults = guard.flushPendingToolResults;
  guardedSessionManager.flushPendingToolResultsAsync = guard.flushPendingToolResultsAsync;
  guardedSessionManager.clearPendingToolResults = guard.clearPendingToolResults;
  guardedSessionManager.setNextUserMessagePersistence = context.setNextUserMessagePersistence;
  guardedSessionManager.clearTranscriptRunCallbacks = context.release;
  guardedSessionManager.setTranscriptRunContext = (nextOptions) => {
    context = createTranscriptRunContext(sessionManager, nextOptions, true);
    guardedSessionManager.setNextUserMessagePersistence = context.setNextUserMessagePersistence;
    guardedSessionManager.clearTranscriptRunCallbacks = context.release;
  };
  return guardedSessionManager;
}
