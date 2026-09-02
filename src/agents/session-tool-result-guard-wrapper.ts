/**
 * Session manager wrapper for tool-result transcript guards.
 *
 * Installs message-write hooks, input provenance handling, and pending tool-result flush behavior once per manager.
 */

import type { PrepareAssistantTranscriptMessage } from "../config/sessions/transcript-assistant-delivery.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import type { CodeModeTranscriptAuthority } from "./code-mode-waiting-claim.js";
import type { EmbeddedRunTrigger } from "./embedded-agent-runner/run/params.js";
import { resolveLiveToolResultMaxChars } from "./embedded-agent-runner/tool-result-truncation.js";
import { runAgentHarnessBeforeMessageWriteHook } from "./harness/hook-helpers.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "./harness/transcript-visibility.js";
import type { AgentMessage } from "./runtime/index.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import type { SessionManager } from "./sessions/index.js";
import {
  copyCodeModeSourceAppend,
  type CodeModeSourceAppend,
} from "./transcript-code-mode-source.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

type GuardedSessionManager = SessionManager & {
  /** Flush any synthetic tool results for pending tool calls. Idempotent. */
  flushPendingToolResults?: () => void;
  /** Clear pending tool calls without persisting synthetic tool results. Idempotent. */
  clearPendingToolResults?: () => void;
  /** Persist the next user message when an earlier canonical entry was removed. */
  clearNextUserMessagePersistenceSuppression?: () => void;
  /** Refresh the exact owning run when a caller reuses this guarded manager. */
  setTranscriptRunContext?: (
    runId: string | undefined,
    prepareAssistantTranscriptMessage: PrepareAssistantTranscriptMessage | undefined,
    skipBeforeMessageWriteHooks: boolean | undefined,
    authority: CodeModeTranscriptAuthority | undefined,
  ) => void;
};

export function createSessionTranscriptMessagePreparer(params: {
  agentId?: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  hidden?: boolean;
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  skipBeforeMessageWriteHooks?: boolean;
}) {
  return (
    source: AgentMessage,
    sourceAppend?: CodeModeSourceAppend,
    afterPrepare?: (message: AgentMessage) => AgentMessage,
    skipBeforeMessageWriteHooks = params.skipBeforeMessageWriteHooks,
  ): AgentMessage | null => {
    let message = source;
    if (
      (!skipBeforeMessageWriteHooks && getGlobalHookRunner()?.hasHooks("before_message_write")) ||
      params.prepareAssistantTranscriptMessage
    ) {
      const next = runAgentHarnessBeforeMessageWriteHook({
        ...params,
        message,
        skipBeforeMessageWriteHooks,
      });
      if (!next) {
        return null;
      }
      message = afterPrepare?.(next) ?? next;
    }
    copyCodeModeSourceAppend(source, message, sourceAppend);
    message = redactTranscriptMessage(message, params.config, sourceAppend);
    const projected = projectAgentHarnessTranscriptMessageForDisplay({
      hidden: params.hidden === true,
      message,
    });
    if (projected !== message) {
      copyCodeModeSourceAppend(message, projected, sourceAppend);
    }
    return projected;
  };
}

/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export function guardSessionManager(
  sessionManager: SessionManager,
  opts?: {
    agentId?: string;
    runId?: string;
    prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
    codeModeTranscriptAuthority?: CodeModeTranscriptAuthority;
    sessionKey?: string;
    config?: OpenClawConfig;
    contextWindowTokens?: number;
    inputProvenance?: InputProvenance;
    allowSyntheticToolResults?: boolean;
    missingToolResultText?: string;
    allowedToolNames?: Iterable<string>;
    trigger?: EmbeddedRunTrigger;
    preparedUserTurnMessage?: PersistedUserTurnMessage;
    preparedUserTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
    suppressNextUserMessagePersistence?: boolean;
    suppressTranscriptOnlyAssistantPersistence?: boolean;
    suppressAssistantErrorPersistence?: boolean;
    /** Finalization keeps core redaction but must not run plugin write hooks. */
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
    withCompactionPersistence?: (
      append: () => string,
      validateAppend: (entryId: string, appendedText: string) => boolean,
    ) => string;
    onAssistantErrorMessagePersisted?: (
      message: Extract<AgentMessage, { role: "assistant" }>,
    ) => void | Promise<void>;
  },
): GuardedSessionManager {
  const guardedSessionManager: GuardedSessionManager = sessionManager;
  const transcriptPreparation: Parameters<typeof createSessionTranscriptMessagePreparer>[0] = {
    ...opts,
    hidden: opts?.trigger === "memory",
    prepareAssistantTranscriptMessage:
      opts?.trigger === "memory" ? undefined : opts?.prepareAssistantTranscriptMessage,
  };
  const prepareTranscriptMessage = createSessionTranscriptMessagePreparer(transcriptPreparation);
  if (typeof guardedSessionManager.flushPendingToolResults === "function") {
    guardedSessionManager.setTranscriptRunContext?.(
      opts?.runId,
      transcriptPreparation.prepareAssistantTranscriptMessage,
      transcriptPreparation.skipBeforeMessageWriteHooks,
      opts?.codeModeTranscriptAuthority,
    );
    return guardedSessionManager;
  }

  const hookRunner = getGlobalHookRunner();
  let pendingPreparedUserTurnMessage = opts?.preparedUserTurnMessage;
  let queuedUserTurnTranscriptRecorder: UserTurnTranscriptRecorder | undefined;
  const runtimeUserMessageByPersistedMessage = new WeakMap<
    AgentMessage,
    Extract<AgentMessage, { role: "user" }>
  >();
  const beforeMessageWrite = (
    event: { message: AgentMessage },
    sourceAppend?: CodeModeSourceAppend,
  ) => {
    const runtimeUserMessage = runtimeUserMessageByPersistedMessage.get(event.message);
    // Accepted source bytes already passed the plugin hook before ACK. Only
    // core redaction and visibility still run when the native turn consumes them.
    const skipUserWriteHook =
      transcriptPreparation.skipBeforeMessageWriteHooks ||
      (event.message.role === "user" &&
        queuedUserTurnTranscriptRecorder?.getPendingInputMessage?.() !== undefined);
    const preparedMessage =
      event.message.role === "user"
        ? { ...event.message, __openclaw: { ...Reflect.get(event.message, "__openclaw") } }
        : undefined;
    const prepared = prepareTranscriptMessage(
      event.message,
      sourceAppend,
      (message) =>
        restorePreparedUserTurnOperationalMetaForRuntime({
          runtimeMessage: message,
          preparedMessage,
        }),
      skipUserWriteHook,
    );
    if (!prepared) {
      runtimeUserMessageByPersistedMessage.delete(event.message);
      queuedUserTurnTranscriptRecorder?.markBlocked();
      queuedUserTurnTranscriptRecorder = undefined;
      return { block: true };
    }
    let message = prepared;
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
    return message === event.message ? undefined : { message };
  };

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
            agentId: opts?.agentId,
            sessionKey: opts?.sessionKey,
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
          },
        );
        return out?.message ?? message;
      }
    : undefined;

  const guard = installSessionToolResultGuard(sessionManager, {
    sessionKey: opts?.sessionKey,
    agentId: opts?.agentId,
    runId: opts?.runId,
    codeModeTranscriptAuthority: opts?.codeModeTranscriptAuthority,
    transformMessageForPersistence: (message) => {
      queuedUserTurnTranscriptRecorder = undefined;
      const withProvenance = applyInputProvenanceToUserMessage(message, opts?.inputProvenance);
      const runtimeContext = takeRuntimeUserTurnTranscriptContext(message);
      const prepared = runtimeContext?.message ?? pendingPreparedUserTurnMessage;
      const recorder =
        runtimeContext?.recorder ??
        (prepared !== undefined && prepared === pendingPreparedUserTurnMessage
          ? opts?.preparedUserTurnTranscriptRecorder
          : undefined);
      if (message.role === "user") {
        opts?.onUserMessagePreparingForPersistence?.(message, recorder, prepared);
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
    },
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
    missingToolResultText: opts?.missingToolResultText,
    allowedToolNames: opts?.allowedToolNames,
    beforeMessageWriteHook: beforeMessageWrite,
    redactLoggingConfig: opts?.config?.logging,
    maxToolResultChars:
      typeof opts?.contextWindowTokens === "number"
        ? resolveLiveToolResultMaxChars({
            contextWindowTokens: opts.contextWindowTokens,
          })
        : undefined,
    suppressNextUserMessagePersistence: opts?.suppressNextUserMessagePersistence,
    suppressTranscriptOnlyAssistantPersistence: opts?.suppressTranscriptOnlyAssistantPersistence,
    suppressAssistantErrorPersistence: opts?.suppressAssistantErrorPersistence,
    onMessagePersisted: opts?.onMessagePersisted,
    withCompactionPersistence: opts?.withCompactionPersistence,
    onUserMessagePersisted: async (message, persistence) => {
      const runtimeMessage = runtimeUserMessageByPersistedMessage.get(message);
      runtimeUserMessageByPersistedMessage.delete(message);
      const recorder = takeRuntimeUserTurnTranscriptRecorder(message);
      recorder?.markRuntimePersisted(message, persistence.anchor);
      await opts?.onUserMessagePersisted?.(message, runtimeMessage);
    },
    onUserMessagePersistenceSuppressed: async (message) => {
      const runtimeMessage = runtimeUserMessageByPersistedMessage.get(message);
      runtimeUserMessageByPersistedMessage.delete(message);
      await opts?.onUserMessagePersistenceSuppressed?.(message, runtimeMessage);
    },
    onUserMessageBlocked: opts?.onUserMessageBlocked,
    onAssistantErrorMessagePersisted: opts?.onAssistantErrorMessagePersisted,
  });
  guardedSessionManager.flushPendingToolResults = guard.flushPendingToolResults;
  guardedSessionManager.clearPendingToolResults = guard.clearPendingToolResults;
  guardedSessionManager.clearNextUserMessagePersistenceSuppression =
    guard.clearNextUserMessagePersistenceSuppression;
  guardedSessionManager.setTranscriptRunContext = (runId, prepare, skipHooks, authority) => {
    guard.setTranscriptAuthority(authority);
    guard.setTranscriptRunId(runId);
    transcriptPreparation.prepareAssistantTranscriptMessage = prepare;
    transcriptPreparation.skipBeforeMessageWriteHooks = skipHooks;
  };
  return guardedSessionManager;
}
