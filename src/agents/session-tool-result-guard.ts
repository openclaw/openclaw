/**
 * Session transcript guard for tool-call/result consistency.
 *
 * Caps large tool results, repairs missing results, applies redaction, and emits transcript update events.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { publishTranscriptUpdate } from "../config/sessions/session-accessor.js";
import type { TranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
} from "../plugins/types.js";
import {
  attachSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../sessions/transcript-events.js";
import { withRuntimeUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript-runtime-context.js";
import { isTranscriptOnlyOpenClawAssistantModel } from "../shared/transcript-only-openclaw-assistant.js";
import type { AssistantErrorTranscript } from "./assistant-error-transcript.js";
import type { AgentMessage } from "./runtime/index.js";
import { acknowledgeInternalToolResult } from "./runtime/internal-hooks.js";
import {
  getRawSessionAppendMessage,
  setRawSessionAppendMessage,
} from "./session-raw-append-message.js";
import {
  capToolResultForPersistence,
  normalizePersistedToolResultName,
  resolveMaxToolResultChars,
} from "./session-tool-result-guard.payload.js";
import { resolveAppendedMessageSeq } from "./session-tool-result-guard.transcript-seq.js";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";
import type { SessionManager } from "./sessions/index.js";
import {
  withSessionCompactionPersistence,
  withSessionCompactionPersistenceAsync,
} from "./sessions/session-compaction-persistence.js";
import type { CompactionAppendPersistence } from "./sessions/session-compaction-persistence.js";
import { withSessionManagerWrite } from "./sessions/session-manager-write-admission.js";
import {
  extractToolCallsFromAssistant,
  extractToolResultId,
  rewriteToolResultIds,
} from "./tool-call-id.js";
import {
  copyCodeModeSourceAppend,
  copyCodeModeSourceAppendOptions,
  prepareCodeModeSourceAppend,
  withCodeModeSourceAppend,
  type CodeModeSourceAppend,
} from "./transcript-code-mode-source.js";

type UserAgentMessage = Extract<AgentMessage, { role: "user" }>;
type AsyncMessageCallback<T extends AgentMessage> = (message: T) => void | Promise<void>;
type UserMessagePersistedCallback = (
  message: UserAgentMessage,
  context: {
    anchor?: TranscriptEntryAnchor;
    appended: boolean;
    entryId: string;
    persistedMessage: UserAgentMessage;
    sessionTarget?: ReturnType<SessionManager["getSessionTarget"]>;
  },
) => void | Promise<void>;
type AppendMessageOptions = Parameters<SessionManager["appendMessage"]>[1];
type AppendReceipt = Awaited<ReturnType<SessionManager["appendMessageWithTranscriptAnchorAsync"]>>;
type AppendRequest = {
  message: AgentMessage;
  options?: AppendMessageOptions;
  sourceAppend?: CodeModeSourceAppend;
};

function isUserAgentMessage(message: AgentMessage): message is UserAgentMessage {
  return message.role === "user";
}

function isTranscriptOnlyOpenClawAssistantMessage(message: AgentMessage): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const provider = normalizeOptionalString(message.provider) ?? "";
  const model = normalizeOptionalString(message.model) ?? "";
  return isTranscriptOnlyOpenClawAssistantModel(provider, model);
}

function extractPendingAssistantToolCalls(message: AgentMessage) {
  return message.role === "assistant" &&
    message.stopReason !== "aborted" &&
    message.stopReason !== "error"
    ? extractToolCallsFromAssistant(message)
    : [];
}

/**
 * Identities of one streamed assistant response. The runtime turnId is carried by every
 * fragment; the provider responseId can first appear on a later fragment.
 */
function assistantResponseIds(message: AgentMessage): string[] {
  if (message.role !== "assistant") {
    return [];
  }
  return [message.responseId, message.turnId].flatMap((id) => normalizeOptionalString(id) ?? []);
}

function clearsPendingToolCalls(
  message: AgentMessage,
  toolCalls: ReturnType<typeof extractPendingAssistantToolCalls>,
  allowSyntheticToolResults: boolean,
  pendingResponseIds: readonly string[],
): boolean {
  if (message.role === "toolResult") {
    return false;
  }
  // Async tool execution commits each call as a fragment of one provider response while the
  // response keeps streaming. A later fragment of that response is not a turn boundary.
  if (assistantResponseIds(message).some((id) => pendingResponseIds.includes(id))) {
    return false;
  }
  const transcriptOnly =
    (message.role === "custom" &&
      "excludeFromContext" in message &&
      message.excludeFromContext === true) ||
    (message.role === "assistant" &&
      toolCalls.length === 0 &&
      isTranscriptOnlyOpenClawAssistantMessage(message));
  return (
    (!transcriptOnly && (toolCalls.length === 0 || message.role !== "assistant")) ||
    (!allowSyntheticToolResults && toolCalls.length > 0)
  );
}

export function installSessionToolResultGuard(
  sessionManager: SessionManager,
  opts?: {
    /** Optional session key for transcript update broadcasts. */
    sessionKey?: string;
    /** Optional agent id for selected-global transcript update broadcasts. */
    agentId?: string;
    /** Exact run that owns terminal assistant transcript updates. */
    runId?: string;
    /**
     * Optional transform applied to any message before persistence.
     */
    transformMessageForPersistence?: (message: AgentMessage) => AgentMessage;
    /**
     * Optional, synchronous transform applied to toolResult messages *before* they are
     * persisted to the session transcript.
     */
    transformToolResultForPersistence?: (
      message: AgentMessage,
      meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
    ) => AgentMessage;
    /**
     * Whether to synthesize missing tool results to satisfy strict providers.
     * Defaults to true.
     */
    allowSyntheticToolResults?: boolean;
    missingToolResultText?: string;
    /**
     * Optional set/list of tool names accepted for assistant toolCall/toolUse blocks.
     * When set, tool calls with unknown names are dropped before persistence.
     */
    allowedToolNames?: Iterable<string>;
    /**
     * Synchronous hook invoked before any message is written to the session JSONL.
     * If the hook returns { block: true }, the message is silently dropped.
     * If it returns { message }, the modified message is written instead.
     */
    beforeMessageWriteHook?: (
      event: PluginHookBeforeMessageWriteEvent,
      sourceAppend?: CodeModeSourceAppend,
    ) => PluginHookBeforeMessageWriteResult | undefined;
    config?: OpenClawConfig;
    maxToolResultChars?: number;
    suppressNextUserMessagePersistence?: boolean;
    suppressTranscriptOnlyAssistantPersistence?: boolean;
    assistantErrorTranscript?: AssistantErrorTranscript;
    onUserMessagePersisted?: UserMessagePersistedCallback;
    onUserMessagePersistenceSuppressed?: AsyncMessageCallback<UserAgentMessage>;
    onUserMessageBlocked?: (message: UserAgentMessage) => void;
    onMessagePersisted?: (message: AgentMessage) => void | Promise<void>;
    withCompactionPersistence?: CompactionAppendPersistence;
  },
): {
  hasPendingToolResults: () => boolean;
  flushPendingToolResults: () => void;
  clearPendingToolResults: () => void;
  clearNextUserMessagePersistenceSuppression: () => void;
  getPendingIds: () => string[];
  setTranscriptRunId: (runId: string | undefined, errors?: AssistantErrorTranscript) => void;
} {
  const originalAppend = getRawSessionAppendMessage(sessionManager);
  const originalAppendWithTranscriptAnchor =
    sessionManager.appendMessageWithTranscriptAnchor.bind(sessionManager);
  const originalAppendWithTranscriptAnchorAsync =
    sessionManager.appendMessageWithTranscriptAnchorAsync.bind(sessionManager);
  setRawSessionAppendMessage(sessionManager, originalAppend);
  const pending = new Map<string, string | undefined>();
  // Response that most recently added pending tool calls; see clearsPendingToolCalls.
  let pendingResponseIds: readonly string[] = [];
  const persistMessage = (message: AgentMessage, sourceAppend?: CodeModeSourceAppend) => {
    const transformer = opts?.transformMessageForPersistence;
    const persisted = transformer ? transformer(message) : message;
    copyCodeModeSourceAppend(message, persisted, sourceAppend);
    return persisted;
  };

  const persistToolResult = (
    message: AgentMessage,
    meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
  ) => {
    const transformer = opts?.transformToolResultForPersistence;
    return transformer ? transformer(message, meta) : message;
  };

  const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;
  const missingToolResultText = opts?.missingToolResultText;
  const beforeWrite = opts?.beforeMessageWriteHook;
  const toolResultTransformerMayMutate = opts?.transformToolResultForPersistence !== undefined;
  const redactionConfig = opts?.config?.logging;
  const maxToolResultChars = resolveMaxToolResultChars(opts);
  const transcriptSeqByEntryId = new Map<string, number>();
  let transcriptRunId = opts?.runId;
  let assistantErrorTranscript = opts?.assistantErrorTranscript;
  let suppressNextUserMessagePersistence = opts?.suppressNextUserMessagePersistence === true;

  const appendRequest = <T>(
    request: AppendRequest,
    append: (
      message: Parameters<SessionManager["appendMessage"]>[0],
      options?: AppendMessageOptions,
    ) => T,
  ): T =>
    withRuntimeUserTurnTranscriptRecorder(request.message, (beforeFreshMessageCommit) => {
      const appendOptions =
        opts?.config || beforeFreshMessageCommit
          ? copyCodeModeSourceAppendOptions(request.options, {
              ...request.options,
              ...(opts?.config ? { config: opts.config } : {}),
              ...(beforeFreshMessageCommit ? { beforeFreshMessageCommit } : {}),
            })
          : request.options;
      return append(
        request.message as never,
        request.sourceAppend
          ? prepareCodeModeSourceAppend(appendOptions ?? {}, request.message, request.sourceAppend)
          : appendOptions,
      );
    });
  const runSync = <T>(operation: Generator<AppendRequest, T, AppendReceipt>): T => {
    let next = operation.next();
    while (!next.done) {
      next = operation.next(appendRequest(next.value, originalAppendWithTranscriptAnchor));
    }
    return next.value;
  };
  const runAsync = async <T>(operation: Generator<AppendRequest, T, AppendReceipt>): Promise<T> => {
    let next = operation.next();
    while (!next.done) {
      next = operation.next(
        await appendRequest(next.value, originalAppendWithTranscriptAnchorAsync),
      );
    }
    return next.value;
  };

  const updatePending = (
    message: AgentMessage,
    calls = extractPendingAssistantToolCalls(message),
  ) => {
    const resultId = message.role === "toolResult" ? extractToolResultId(message) : null;
    if (resultId) {
      pending.delete(resultId);
    }
    for (const call of calls) {
      pending.set(call.id, call.name);
    }
    if (calls.length > 0) {
      pendingResponseIds = assistantResponseIds(message);
    }
  };
  const recordPendingReceipt = (
    entryId: string,
    message: AgentMessage,
    viewWasSuperseded: boolean,
  ) => {
    if (!viewWasSuperseded) {
      updatePending(message);
      return;
    }
    const branch = sessionManager.getBranch();
    const committedIndex = branch.findIndex((entry) => entry.id === entryId);
    // A selected or bounded successor view may intentionally omit this older receipt.
    if (committedIndex < 0) {
      return;
    }
    for (let index = committedIndex; index < branch.length; index++) {
      const entry = branch[index];
      if (entry?.type !== "message") {
        continue;
      }
      const calls = extractPendingAssistantToolCalls(entry.message);
      if (
        clearsPendingToolCalls(entry.message, calls, allowSyntheticToolResults, pendingResponseIds)
      ) {
        pending.clear();
      }
      updatePending(entry.message, calls);
    }
  };

  function* appendMessageAndCacheTranscriptSeq(
    message: AgentMessage,
    options?: AppendMessageOptions,
    sourceAppend?: CodeModeSourceAppend,
    acknowledgementSource: AgentMessage = message,
  ): Generator<
    AppendRequest,
    {
      anchor?: TranscriptEntryAnchor;
      appended: boolean;
      entryId: string;
      lifecycleRevision?: string;
      message: AgentMessage;
      messageSeq?: number;
      sessionTarget?: ReturnType<SessionManager["getSessionTarget"]>;
    },
    AppendReceipt
  > {
    const runOwnedMessage = attachSessionTranscriptRunId(message, transcriptRunId);
    copyCodeModeSourceAppend(message, runOwnedMessage, sourceAppend);
    const parentEntryId = sessionManager.getLeafId();
    const originalTarget = sessionManager.getSessionTarget();
    const {
      entryId,
      anchor,
      appended,
      lifecycleRevision,
      message: persistedMessage,
      viewWasSuperseded,
    } = yield { message: runOwnedMessage, options, sourceAppend };
    const sessionTarget = anchor
      ? {
          agentId: anchor.agentId,
          sessionId: anchor.sessionId,
          sessionKey: anchor.sessionKey,
          storePath: anchor.storePath,
        }
      : originalTarget;
    if (viewWasSuperseded) {
      transcriptSeqByEntryId.clear();
    }
    const persistedEntry = sessionManager.getEntry(entryId);
    const messageSeq =
      appended && sessionTarget && (!viewWasSuperseded || persistedEntry)
        ? resolveAppendedMessageSeq({
            sessionManager,
            entryId,
            parentEntryId: persistedEntry ? persistedEntry.parentId : parentEntryId,
            seqByEntryId: transcriptSeqByEntryId,
          })
        : undefined;
    // Destructive tool-side state commits only after this exact result is durable.
    acknowledgeInternalToolResult(acknowledgementSource);
    // Update only committed state, before callbacks can re-enter or throw.
    recordPendingReceipt(entryId, persistedMessage, viewWasSuperseded === true);
    if (!appended) {
      return { entryId, message: persistedMessage, appended, ...(anchor ? { anchor } : {}) };
    }
    void opts?.onMessagePersisted?.(persistedMessage);
    if (!sessionTarget) {
      return { entryId, message: persistedMessage, appended, ...(anchor ? { anchor } : {}) };
    }
    return {
      entryId,
      appended,
      lifecycleRevision,
      message: persistedMessage,
      ...(anchor ? { anchor } : {}),
      sessionTarget,
      messageSeq,
    };
  }
  const originalAppendCompaction = sessionManager.appendCompaction.bind(sessionManager);
  const guardedAppendCompaction = ((
    ...args: Parameters<SessionManager["appendCompaction"]>
  ): string => {
    // Replayed boundaries supply their recorded identity; new ones inherit the owning run.
    args[5] = { runId: transcriptRunId, ...args[5] };
    return withSessionCompactionPersistence(sessionManager, opts?.withCompactionPersistence, () =>
      originalAppendCompaction(...args),
    );
  }) as SessionManager["appendCompaction"];
  const originalAppendCompactionAsync = sessionManager.appendCompactionAsync.bind(sessionManager);
  const guardedAppendCompactionAsync: SessionManager["appendCompactionAsync"] = (...args) => {
    args[5] = { runId: transcriptRunId, ...args[5] };
    return withSessionCompactionPersistenceAsync(
      sessionManager,
      opts?.withCompactionPersistence,
      () => originalAppendCompactionAsync(...args),
    );
  };

  /**
   * Run the before_message_write hook. Returns the (possibly modified) message,
   * or null if the message should be blocked.
   */
  const applyBeforeWriteHook = (
    msg: AgentMessage,
    sourceAppend?: CodeModeSourceAppend,
  ): { message: AgentMessage; changed: boolean } | null => {
    if (!beforeWrite) {
      return { message: msg, changed: false };
    }
    const result = beforeWrite({ message: msg }, sourceAppend);
    if (result?.block) {
      return null;
    }
    if (result?.message) {
      return { message: result.message, changed: true };
    }
    return { message: msg, changed: false };
  };

  function* flushPendingToolResultsOperation(): Generator<AppendRequest, void, AppendReceipt> {
    if (pending.size === 0) {
      return;
    }
    if (allowSyntheticToolResults) {
      for (const [id, name] of pending.entries()) {
        const synthetic = makeMissingToolResult({
          toolCallId: id,
          toolName: name,
          text: missingToolResultText,
        });
        const persistedSynthetic = persistMessage(synthetic);
        const transformed = persistToolResult(persistedSynthetic, {
          toolCallId: id,
          toolName: name,
          isSynthetic: true,
        });
        const flushed = applyBeforeWriteHook(transformed);
        if (flushed) {
          // Payload hooks still run, but this repair already owns a persisted call ID.
          const canonical =
            flushed.message.role === "toolResult"
              ? rewriteToolResultIds({ message: flushed.message, resolveId: () => id })
              : flushed.message;
          yield* appendMessageAndCacheTranscriptSeq(
            capToolResultForPersistence(canonical, maxToolResultChars, redactionConfig),
            {
              invalidateSerializedPrefixCache:
                persistedSynthetic !== synthetic ||
                toolResultTransformerMayMutate ||
                canonical !== flushed.message ||
                flushed.changed,
            },
          );
        }
      }
    }
    pending.clear();
  }
  const flushPendingToolResults = () => runSync(flushPendingToolResultsOperation());

  const clearPendingToolResults = () => {
    pending.clear();
  };

  function* guardedAppend(
    message: AgentMessage,
    callerOptions?: AppendMessageOptions,
    sourceAppend?: CodeModeSourceAppend,
  ): Generator<AppendRequest, string | undefined, AppendReceipt> {
    const callerInvalidatesCache = callerOptions?.invalidateSerializedPrefixCache === true;
    let nextMessage = message;
    if (message.role === "assistant") {
      const sanitized = sanitizeToolCallInputs([message], {
        allowedToolNames: opts?.allowedToolNames,
      });
      if (sanitized.length === 0) {
        if (pending.size > 0) {
          yield* flushPendingToolResultsOperation();
        }
        return undefined;
      }
      nextMessage = sanitized[0]!;
      copyCodeModeSourceAppend(message, nextMessage, sourceAppend);
    }
    if (nextMessage.role === "toolResult") {
      const id = extractToolResultId(nextMessage);
      const toolName = id ? pending.get(id) : undefined;
      const normalizedToolResult = normalizePersistedToolResultName(
        nextMessage,
        toolName,
        id ?? undefined,
      );
      // Apply hard size cap before persistence to prevent oversized tool results
      // from consuming the entire context window on subsequent LLM calls.
      const persistedToolResult = persistMessage(normalizedToolResult);
      const capped = capToolResultForPersistence(
        persistedToolResult,
        maxToolResultChars,
        redactionConfig,
      );
      const transformed = persistToolResult(capped, {
        toolCallId: id ?? undefined,
        toolName,
        isSynthetic: false,
      });
      const persisted = applyBeforeWriteHook(transformed);
      if (!persisted) {
        return undefined;
      }
      // A blocked or failed append must remain pending for transcript repair.
      return (yield* appendMessageAndCacheTranscriptSeq(
        capToolResultForPersistence(persisted.message, maxToolResultChars, redactionConfig),
        {
          invalidateSerializedPrefixCache:
            callerInvalidatesCache ||
            persistedToolResult !== normalizedToolResult ||
            toolResultTransformerMayMutate ||
            persisted.changed,
        },
        undefined,
        message,
      )).entryId;
    }

    // Skip tool call extraction for aborted/errored assistant messages.
    // When stopReason is "error" or "aborted", the tool_use blocks may be incomplete
    // and should not have synthetic tool_results created. Creating synthetic results
    // for incomplete tool calls causes API 400 errors:
    // "unexpected tool_use_id found in tool_result blocks"
    // This matches the behavior in repairToolUseResultPairing (session-transcript-repair.ts)
    const toolCalls = extractPendingAssistantToolCalls(nextMessage);

    // Always clear pending tool call state before appending non-tool-result messages.
    // flushPendingToolResults() only inserts synthetic results when allowSyntheticToolResults
    // is true; it always clears the pending map. Without this, providers that disable
    // synthetic results (e.g. OpenAI) accumulate stale pending state when a user message
    // interrupts in-flight tool calls, leaving orphaned tool_use blocks in the transcript
    // that cause API 400 errors on subsequent requests.
    // If synthetic results are disabled, a new assistant tool-call turn is a safe
    // boundary to drop older pending ids. When synthetic results are enabled,
    // do not synthesize here: parallel tool-result appends can still be racing
    // this assistant append, and transcript repair can move late real results
    // back into strict provider order before the next replay.
    if (
      pending.size > 0 &&
      clearsPendingToolCalls(nextMessage, toolCalls, allowSyntheticToolResults, pendingResponseIds)
    ) {
      yield* flushPendingToolResultsOperation();
    }

    const transformedMessage = persistMessage(nextMessage, sourceAppend);
    const finalWrite = applyBeforeWriteHook(transformedMessage, sourceAppend);
    if (!finalWrite) {
      if (isUserAgentMessage(transformedMessage)) {
        opts?.onUserMessageBlocked?.(transformedMessage);
      }
      return undefined;
    }
    let finalMessage = finalWrite.message;
    if (
      finalMessage.role === "assistant" &&
      toolCalls.length === 0 &&
      opts?.suppressTranscriptOnlyAssistantPersistence === true
    ) {
      return undefined;
    }
    if (
      finalMessage.role === "assistant" &&
      assistantErrorTranscript &&
      finalMessage.stopReason === "error"
    ) {
      const target = sessionManager.getSessionTarget();
      if (target) {
        const replayMessage = assistantErrorTranscript.record(finalMessage, target, message);
        if (!replayMessage) {
          return undefined;
        }
        copyCodeModeSourceAppend(finalMessage, replayMessage, sourceAppend);
        finalMessage = replayMessage;
      }
    }
    if (isUserAgentMessage(finalMessage) && suppressNextUserMessagePersistence) {
      suppressNextUserMessagePersistence = false;
      void opts?.onUserMessagePersistenceSuppressed?.(finalMessage);
      return undefined;
    }
    const {
      anchor,
      appended,
      entryId: result,
      lifecycleRevision,
      message: persistedMessage,
      messageSeq,
      sessionTarget,
    } = yield* appendMessageAndCacheTranscriptSeq(
      finalMessage,
      {
        invalidateSerializedPrefixCache:
          callerInvalidatesCache ||
          transformedMessage !== nextMessage ||
          finalWrite.changed ||
          finalMessage !== finalWrite.message,
      },
      sourceAppend,
      message,
    );
    if (sessionTarget) {
      const runId = resolveTerminalAssistantTranscriptRunId(persistedMessage, transcriptRunId);
      void publishTranscriptUpdate(sessionTarget, {
        lifecycleRevision,
        message: persistedMessage,
        messageId: typeof result === "string" ? result : undefined,
        ...(messageSeq !== undefined ? { messageSeq } : {}),
        ...(runId ? { runId } : {}),
      });
    }

    if (isUserAgentMessage(finalMessage) && isUserAgentMessage(persistedMessage)) {
      void opts?.onUserMessagePersisted?.(finalMessage, {
        ...(anchor ? { anchor } : {}),
        appended,
        entryId: result,
        persistedMessage,
        ...(sessionTarget ? { sessionTarget } : {}),
      });
    }

    return result;
  }

  // Monkey-patch appendMessage with our guarded version.
  sessionManager.appendMessage = ((message, options) =>
    withCodeModeSourceAppend(message, options, (sourceAppend) =>
      runSync(guardedAppend(message, options, sourceAppend)),
    )) as SessionManager["appendMessage"];
  sessionManager.appendMessageAsync = (message, options) =>
    withSessionManagerWrite(sessionManager, () =>
      withCodeModeSourceAppend(message, options, (sourceAppend) =>
        runAsync(guardedAppend(message, options, sourceAppend)),
      ),
    );
  sessionManager.appendCompaction = guardedAppendCompaction;
  sessionManager.appendCompactionAsync = guardedAppendCompactionAsync;

  return {
    hasPendingToolResults: () => pending.size > 0,
    flushPendingToolResults,
    clearPendingToolResults,
    clearNextUserMessagePersistenceSuppression: () => {
      suppressNextUserMessagePersistence = false;
    },
    getPendingIds: () => Array.from(pending.keys()),
    setTranscriptRunId: (runId, errors) => {
      transcriptRunId = runId;
      assistantErrorTranscript = errors;
    },
  };
}
