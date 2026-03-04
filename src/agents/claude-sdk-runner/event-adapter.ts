/**
 * Event Adapter: Claude Agent SDK SDKMessage → EmbeddedPiSubscribeEvent
 *
 * Translates Claude Agent SDK `query()` async generator messages into the
 * EmbeddedPiSubscribeEvent format consumed by subscribeEmbeddedPiSession
 * and its 6 handler modules.
 *
 * Event mapping (from implementation-plan.md Section 4.2.1):
 *   system/init             → store claudeSdkSessionId + emit agent_start
 *   stream_event            → real-time token streaming (text_delta, thinking_delta, etc.)
 *   assistant text content  → message_start + message_update (text_delta) + message_end
 *   result                  → agent_end
 *
 * NOTE: tool_execution_start/end events are emitted from mcp-tool-server.ts.
 * This adapter emits tool_execution_update for SDK-native tool progress/summary
 * messages, plus text/thinking/lifecycle/streaming/compaction events.
 */

import type { EmbeddedPiSubscribeEvent } from "../pi-embedded-subscribe.handlers.types.js";
import type { ClaudeSdkEventAdapterState } from "./types.js";

// ---------------------------------------------------------------------------
// SDKMessage type definitions (from @anthropic-ai/claude-agent-sdk)
// We define minimal structural types to avoid depending on uninstalled pkg.
// ---------------------------------------------------------------------------

type SdkSystemInitMessage = {
  type: "system";
  subtype: "init";
  session_id: string;
};

type SdkSystemStatusMessage = {
  type: "system";
  subtype: "status";
  status: "compacting" | null;
  permissionMode?: string;
  session_id: string;
};

type SdkContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

type SdkAssistantMessage = {
  type: "assistant";
  message: {
    role: "assistant";
    content: SdkContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    model?: string;
    stop_reason?: string;
  };
};

type SdkResultMessage = {
  type: "result";
  subtype: string;
  result?: unknown;
};

// SDKCompactBoundaryMessage — emitted when the SDK compacts the conversation context.
// Confirmed in the official TypeScript reference. Handled in Phase 4.
type SdkCompactBoundaryMessage = {
  type: "system";
  subtype: "compact_boundary";
  session_id: string;
  compact_metadata: {
    trigger: "manual" | "auto";
    pre_tokens: number;
    willRetry?: boolean;
    will_retry?: boolean;
  };
  willRetry?: boolean;
  will_retry?: boolean;
};

// SdkResultErrorMessage — emitted when SDK execution fails with an error subtype.
// The subtype starts with "error_" (e.g. "error_during_execution", "error_max_turns").
type SdkResultErrorMessage = {
  type: "result";
  subtype: string;
  is_error?: boolean;
  errors?: unknown[];
  result?: unknown;
};

type SdkToolProgressMessage = {
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  task_id?: string;
};

type SdkToolUseSummaryMessage = {
  type: "tool_use_summary";
  summary: string;
  preceding_tool_use_ids: string[];
};

type SdkUserMessage = {
  type: "user";
  uuid?: string;
  isReplay?: boolean;
  session_id?: string;
};

type SdkAuthStatusMessage = {
  type: "auth_status";
  isAuthenticating: boolean;
  output?: string[];
  error?: string;
};

type SdkRateLimitEvent = {
  type: "rate_limit_event";
  rate_limit_info?: unknown;
};

type SdkPromptSuggestionMessage = {
  type: "prompt_suggestion";
  suggestion?: string;
};

type SdkFilesPersistedMessage = {
  type: "system";
  subtype: "files_persisted";
  files?: Array<{ filename?: string; file_id?: string }>;
  failed?: Array<{ filename?: string; error?: string }>;
};

type SdkHookStartedMessage = {
  type: "system";
  subtype: "hook_started";
  hook_id?: string;
  hook_name?: string;
  hook_event?: string;
};

type SdkHookProgressMessage = {
  type: "system";
  subtype: "hook_progress";
  hook_id?: string;
  hook_name?: string;
  hook_event?: string;
};

type SdkHookResponseMessage = {
  type: "system";
  subtype: "hook_response";
  hook_id?: string;
  hook_name?: string;
  hook_event?: string;
  outcome?: string;
};

type SdkTaskStartedMessage = {
  type: "system";
  subtype: "task_started";
  task_id?: string;
  description?: string;
};

type SdkTaskProgressMessage = {
  type: "system";
  subtype: "task_progress";
  task_id?: string;
  description?: string;
};

type SdkTaskNotificationMessage = {
  type: "system";
  subtype: "task_notification";
  task_id?: string;
  status?: string;
  summary?: string;
};

// ---------------------------------------------------------------------------
// Stream event types (Anthropic streaming API events via includePartialMessages)
// ---------------------------------------------------------------------------

type SdkStreamEvent =
  | {
      type: "message_start";
      message: { role: "assistant"; content: unknown[]; usage?: unknown; model?: string };
    }
  | {
      type: "content_block_start";
      index: number;
      content_block: { type: string; id?: string; name?: string };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta: { type: string; text?: string; thinking?: string; partial_json?: string };
    }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason?: string }; usage?: unknown }
  | { type: "message_stop" };

type SdkPartialAssistantMessage = {
  type: "stream_event";
  event: SdkStreamEvent;
};

export type SdkMessage =
  | SdkSystemInitMessage
  | SdkSystemStatusMessage
  | SdkAssistantMessage
  | SdkUserMessage
  | SdkPartialAssistantMessage
  | SdkResultMessage
  | SdkResultErrorMessage
  | SdkToolProgressMessage
  | SdkToolUseSummaryMessage
  | SdkCompactBoundaryMessage
  | SdkFilesPersistedMessage
  | SdkHookStartedMessage
  | SdkHookProgressMessage
  | SdkHookResponseMessage
  | SdkTaskStartedMessage
  | SdkTaskProgressMessage
  | SdkTaskNotificationMessage
  | SdkAuthStatusMessage
  | SdkRateLimitEvent
  | SdkPromptSuggestionMessage
  | Record<string, unknown>;

type PiStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

function isCompactionCompletionMessage(message: SdkMessage): boolean {
  const msgType = (message as { type?: string }).type;
  // Only treat known post-compaction progress signals as completion.
  // Unknown system/* subtypes should not implicitly close compaction.
  if (msgType === "system") {
    const systemSubtype = (message as { subtype?: string }).subtype;
    if (systemSubtype === "init") {
      return true;
    }
    if (systemSubtype === "status") {
      return (message as SdkSystemStatusMessage).status === null;
    }
    return false;
  }
  if (
    msgType === "stream_event" ||
    msgType === "assistant" ||
    msgType === "result" ||
    msgType === "tool_progress" ||
    msgType === "tool_use_summary"
  ) {
    return true;
  }
  return false;
}

function beginCompaction(
  state: ClaudeSdkEventAdapterState,
  emit: (evt: EmbeddedPiSubscribeEvent) => void,
  metadata?: { pre_tokens?: number; trigger?: "manual" | "auto"; willRetry?: boolean },
): void {
  const next = {
    willRetry: metadata?.willRetry ?? state.pendingCompactionEnd?.willRetry ?? false,
    pre_tokens: metadata?.pre_tokens ?? state.pendingCompactionEnd?.pre_tokens,
    trigger: metadata?.trigger ?? state.pendingCompactionEnd?.trigger,
  };
  state.pendingCompactionEnd = next;
  if (state.compacting) {
    return;
  }
  state.compacting = true;
  emit({
    type: "auto_compaction_start",
    pre_tokens: next.pre_tokens,
    trigger: next.trigger,
  } as EmbeddedPiSubscribeEvent);
}

function finishCompaction(
  state: ClaudeSdkEventAdapterState,
  emit: (evt: EmbeddedPiSubscribeEvent) => void,
): void {
  if (!state.compacting) {
    return;
  }
  const pending = state.pendingCompactionEnd;
  state.compacting = false;
  state.pendingCompactionEnd = undefined;
  if (!pending) {
    return;
  }
  emit({
    type: "auto_compaction_end",
    willRetry: pending.willRetry,
    pre_tokens: pending.pre_tokens,
    trigger: pending.trigger,
  } as EmbeddedPiSubscribeEvent);
}

// ---------------------------------------------------------------------------
// Main translation function
// ---------------------------------------------------------------------------

/**
 * Translates a single Claude Agent SDK SDKMessage into one or more
 * EmbeddedPiSubscribeEvent events, emitted to all subscribers in state.
 *
 * This function is called for each message yielded by the query() generator.
 */
export function translateSdkMessageToEvents(
  message: SdkMessage,
  state: ClaudeSdkEventAdapterState,
): void {
  const emit = (evt: EmbeddedPiSubscribeEvent): void => {
    for (const subscriber of state.subscribers) {
      subscriber(evt);
    }
  };

  // Claude SDK compaction is represented by a single compact_boundary event.
  // We emit start immediately, then emit end at the first subsequent eligible
  // SDK message that proves generation moved forward.
  if (state.compacting && isCompactionCompletionMessage(message)) {
    finishCompaction(state, emit);
  }

  const msgType = (message as { type?: string }).type;

  if (msgType === "tool_progress") {
    const progress = message as SdkToolProgressMessage;
    const toolCallId = progress.tool_use_id;
    const toolName = progress.tool_name;
    if (toolCallId) {
      state.toolNameByUseId.set(toolCallId, toolName);
      emit({
        type: "tool_execution_update",
        toolName,
        toolCallId,
        partialResult: {
          sdkType: "tool_progress",
          elapsedTimeSeconds: progress.elapsed_time_seconds,
          taskId: progress.task_id,
          parentToolUseId: progress.parent_tool_use_id,
        },
      } as EmbeddedPiSubscribeEvent);
    }
    return;
  }

  if (msgType === "tool_use_summary") {
    const summary = message as SdkToolUseSummaryMessage;
    for (const toolCallId of summary.preceding_tool_use_ids ?? []) {
      if (!toolCallId) {
        continue;
      }
      emit({
        type: "tool_execution_update",
        toolName: state.toolNameByUseId.get(toolCallId) ?? "unknown_tool",
        toolCallId,
        partialResult: {
          sdkType: "tool_use_summary",
          summary: summary.summary,
          precedingToolUseIds: summary.preceding_tool_use_ids,
        },
      } as EmbeddedPiSubscribeEvent);
    }
    return;
  }

  // -------------------------------------------------------------------------
  // system/* — init/status/compaction and SDK lifecycle subtypes
  // -------------------------------------------------------------------------
  if (msgType === "system") {
    const subtype = (message as { subtype?: string }).subtype;

    if (subtype === "init") {
      // system/init — store session_id and emit agent_start
      const sessionId = (message as SdkSystemInitMessage).session_id;
      if (sessionId) {
        state.claudeSdkSessionId = sessionId;
      }
      emit({ type: "agent_start" } as EmbeddedPiSubscribeEvent);
    } else if (subtype === "status") {
      const statusMsg = message as SdkSystemStatusMessage;
      state.sdkStatus = statusMsg.status ?? null;
      if (typeof statusMsg.permissionMode === "string") {
        state.sdkPermissionMode = statusMsg.permissionMode;
      }
      if (statusMsg.status === "compacting") {
        state.statusCompactingCount = (state.statusCompactingCount ?? 0) + 1;
        beginCompaction(state, emit);
      } else if (statusMsg.status === null) {
        state.statusIdleCount = (state.statusIdleCount ?? 0) + 1;
        // Some SDK runs emit status=null as the only compaction-complete signal.
        finishCompaction(state, emit);
      }
    } else if (subtype === "compact_boundary") {
      // system/compact_boundary — server-side compaction signal.
      // SDKCompactBoundaryMessage confirmed in the official TypeScript API reference.
      // Emit synthetic auto_compaction_start/end for hook parity.
      // Include compact_metadata fields so handlers can populate tokenCount and
      // trigger in before_compaction/after_compaction hooks and onAgentEvent.
      const compactMsg = message as SdkCompactBoundaryMessage;
      const pre_tokens = compactMsg.compact_metadata?.pre_tokens;
      const trigger = compactMsg.compact_metadata?.trigger;
      const willRetry = extractCompactionWillRetry(compactMsg);
      state.compactBoundaryCount = (state.compactBoundaryCount ?? 0) + 1;
      beginCompaction(state, emit, { pre_tokens, trigger, willRetry });
    } else if (subtype === "files_persisted") {
      const filesPersisted = message as SdkFilesPersistedMessage;
      const persistedByName = state.persistedFileIdsByName ?? new Map<string, string>();
      const failedByName = state.failedPersistedFilesByName ?? new Map<string, string>();
      const persistedEvents = state.persistedFileEvents ?? [];
      const failedEvents = state.failedPersistedFileEvents ?? [];
      const observedAt = Date.now();
      for (const file of filesPersisted.files ?? []) {
        if (!file?.file_id) {
          continue;
        }
        if (file.filename) {
          persistedByName.set(file.filename, file.file_id);
          failedByName.delete(file.filename);
        }
        persistedEvents.push({
          filename: file.filename,
          fileId: file.file_id,
          observedAt,
        });
      }
      for (const failure of filesPersisted.failed ?? []) {
        if (!failure) {
          continue;
        }
        const error = failure.error ?? "unknown";
        if (failure.filename) {
          failedByName.set(failure.filename, error);
        }
        failedEvents.push({
          filename: failure.filename,
          error,
          observedAt,
        });
      }
      state.persistedFileIdsByName = persistedByName;
      state.failedPersistedFilesByName = failedByName;
      state.persistedFileEvents = persistedEvents;
      state.failedPersistedFileEvents = failedEvents;
    } else if (subtype === "hook_started") {
      const hook = message as SdkHookStartedMessage;
      state.lastHookEvent = {
        subtype: "hook_started",
        hookId: hook.hook_id,
        hookName: hook.hook_name,
        hookEvent: hook.hook_event,
      };
    } else if (subtype === "hook_progress") {
      const hook = message as SdkHookProgressMessage;
      state.lastHookEvent = {
        subtype: "hook_progress",
        hookId: hook.hook_id,
        hookName: hook.hook_name,
        hookEvent: hook.hook_event,
      };
    } else if (subtype === "hook_response") {
      const hook = message as SdkHookResponseMessage;
      state.lastHookEvent = {
        subtype: "hook_response",
        hookId: hook.hook_id,
        hookName: hook.hook_name,
        hookEvent: hook.hook_event,
        outcome: hook.outcome,
      };
    } else if (subtype === "task_started") {
      const task = message as SdkTaskStartedMessage;
      state.lastTaskEvent = {
        subtype: "task_started",
        taskId: task.task_id,
        description: task.description,
      };
    } else if (subtype === "task_progress") {
      const task = message as SdkTaskProgressMessage;
      state.lastTaskEvent = {
        subtype: "task_progress",
        taskId: task.task_id,
        description: task.description,
      };
    } else if (subtype === "task_notification") {
      const task = message as SdkTaskNotificationMessage;
      state.lastTaskEvent = {
        subtype: "task_notification",
        taskId: task.task_id,
        status: task.status,
        description: task.summary,
      };
    }
    // Other system subtypes are intentionally ignored.
    return;
  }

  // -------------------------------------------------------------------------
  // stream_event — real-time streaming deltas (includePartialMessages: true)
  // -------------------------------------------------------------------------
  if (msgType === "stream_event") {
    const streamMsg = message as SdkPartialAssistantMessage;
    handleStreamEvent(streamMsg.event, state, emit);
    return;
  }

  // -------------------------------------------------------------------------
  // assistant — translate content blocks to message events
  // -------------------------------------------------------------------------
  if (msgType === "assistant") {
    const assistantMsg = (message as SdkAssistantMessage).message;
    if (!assistantMsg || assistantMsg.role !== "assistant") {
      return;
    }

    const content = assistantMsg.content ?? [];

    if (state.streamingInProgress) {
      // Streaming path: real-time events (message_start/update/end) were already
      // emitted by handleStreamEvent as stream_event messages arrived. Skip
      // translateAssistantContent to avoid double-emitting. Clear streaming state
      // so subsequent turns start clean.
      state.streamingInProgress = false;
      state.streamingPartialMessage = null;
    } else {
      // Non-streaming fallback — emit full event sequence from the complete message.
      translateAssistantContent(
        content,
        assistantMsg,
        emit,
        allocateMessageId(state, assistantMsg),
        state,
      );
    }

    // The three calls below run unconditionally for BOTH streaming and non-streaming:

    // (1) JSONL persistence always uses the complete assistant message (authoritative
    //     stop_reason, usage, and tool input) regardless of streaming mode.
    persistAssistantMessage(message as SdkAssistantMessage, content, state);

    // (2) Arm the MCP tool server with tool_use blocks from the complete message.
    //     The streaming accumulation in streamingPartialMessage (content_block_start/
    //     delta/stop) is for subscriber event parity only — actual tool execution
    //     depends on consumePendingToolUse() reading from this queue. See design-notes.md.
    rememberPendingToolUses(state, content);

    // (3) Push to state.messages so attempt.ts snapshots contain the current turn.
    //     Uses the complete message's stop_reason, not streamingPartialMessage's
    //     captured value — both must agree (same underlying API response).
    const agentMsg = buildAgentMessage(
      assistantMsg,
      content,
      state.streamingMessageId ?? allocateMessageId(state, assistantMsg),
      state,
    );
    state.messages.push(agentMsg as never);
    state.streamingMessageId = null;
    return;
  }

  if (msgType === "user") {
    const userMessage = message as SdkUserMessage;
    if (userMessage.isReplay && typeof userMessage.uuid === "string") {
      if (!state.replayedUserMessageUuids) {
        state.replayedUserMessageUuids = new Set();
      }
      state.replayedUserMessageUuids.add(userMessage.uuid);
    }
    return;
  }

  if (msgType === "auth_status") {
    const authStatus = message as SdkAuthStatusMessage;
    state.lastAuthStatus = {
      isAuthenticating: Boolean(authStatus.isAuthenticating),
      error: authStatus.error,
      output: authStatus.output,
    };
    return;
  }

  if (msgType === "rate_limit_event") {
    const rateLimit = message as SdkRateLimitEvent;
    state.lastRateLimitInfo = rateLimit.rate_limit_info;
    return;
  }

  if (msgType === "prompt_suggestion") {
    const suggestion = message as SdkPromptSuggestionMessage;
    if (typeof suggestion.suggestion === "string") {
      state.lastPromptSuggestion = suggestion.suggestion;
    }
    return;
  }

  // -------------------------------------------------------------------------
  // result — emit agent_end; propagate error when subtype is "error_*"
  // -------------------------------------------------------------------------
  if (msgType === "result") {
    const resultMsg = message as SdkResultErrorMessage;
    // Detect error results: SDK sets subtype to "error_*" or is_error: true.
    if (resultMsg.subtype?.startsWith("error_") || resultMsg.is_error) {
      const firstErrorMsg = extractSdkResultErrorMessage(resultMsg);
      // Store error message so prompt() throws after the for-await loop.
      // This prevents SDK failures from resolving successfully.
      state.sdkResultError = firstErrorMsg;
      state.messages.push(
        buildAgentMessage(
          {
            role: "assistant",
            content: [{ type: "text", text: firstErrorMsg }],
            stop_reason: "error",
            errorMessage: firstErrorMsg,
          },
          [{ type: "text", text: firstErrorMsg }],
          allocateMessageId(state),
          state,
        ) as never,
      );
      // Also include error details on the agent_end event so subscribers
      // (e.g. hooks, monitoring) can inspect the failure without awaiting prompt().
      emit({
        type: "agent_end",
        error: { subtype: resultMsg.subtype, message: firstErrorMsg },
      } as EmbeddedPiSubscribeEvent);
    } else {
      emit({ type: "agent_end" } as EmbeddedPiSubscribeEvent);
    }
    return;
  }

  // Unknown message types are ignored
}

function allocateMessageId(state: ClaudeSdkEventAdapterState, message?: unknown): string {
  const explicitId =
    message && typeof message === "object" ? (message as { id?: unknown }).id : undefined;
  if (typeof explicitId === "string" && explicitId.length > 0) {
    return explicitId;
  }
  state.messageIdCounter += 1;
  return `sdk-msg-${state.messageIdCounter}`;
}

function extractCompactionWillRetry(message: SdkCompactBoundaryMessage): boolean {
  const directWillRetry =
    typeof message.willRetry === "boolean"
      ? message.willRetry
      : typeof message.will_retry === "boolean"
        ? message.will_retry
        : undefined;
  if (typeof directWillRetry === "boolean") {
    return directWillRetry;
  }
  const metadataWillRetry =
    typeof message.compact_metadata?.willRetry === "boolean"
      ? message.compact_metadata.willRetry
      : typeof message.compact_metadata?.will_retry === "boolean"
        ? message.compact_metadata.will_retry
        : undefined;
  return Boolean(metadataWillRetry);
}

function rememberPendingToolUses(
  state: ClaudeSdkEventAdapterState,
  content: SdkContentBlock[],
): void {
  for (const block of content) {
    if (block.type !== "tool_use") {
      continue;
    }
    state.pendingToolUses.push({
      id: block.id,
      name: block.name,
      input: block.input,
    });
    state.toolNameByUseId.set(block.id, block.name);
  }
}

function extractSdkResultErrorMessage(resultMsg: SdkResultErrorMessage): string {
  if (Array.isArray(resultMsg.errors) && resultMsg.errors.length > 0) {
    const first = resultMsg.errors[0];
    if (typeof first === "string" && first.trim().length > 0) {
      return first.trim();
    }
    if (first && typeof first === "object") {
      const nestedMessage = (first as { message?: unknown }).message;
      if (typeof nestedMessage === "string" && nestedMessage.trim().length > 0) {
        return nestedMessage.trim();
      }
    }
    return String(first);
  }

  if (typeof resultMsg.result === "string" && resultMsg.result.trim().length > 0) {
    return resultMsg.result.trim();
  }
  if (resultMsg.result && typeof resultMsg.result === "object") {
    const nestedMessage = (resultMsg.result as { message?: unknown }).message;
    if (typeof nestedMessage === "string" && nestedMessage.trim().length > 0) {
      return nestedMessage.trim();
    }
  }

  if (typeof resultMsg.subtype === "string" && resultMsg.subtype.startsWith("error_")) {
    return resultMsg.subtype;
  }
  return "SDK execution error";
}

// ---------------------------------------------------------------------------
// Assistant content block translation
// ---------------------------------------------------------------------------

function translateAssistantContent(
  content: SdkContentBlock[],
  fullMessage: {
    role: string;
    content: SdkContentBlock[];
    usage?: unknown;
    model?: string;
    stop_reason?: string;
  },
  emit: (evt: EmbeddedPiSubscribeEvent) => void,
  messageId: string,
  state: ClaudeSdkEventAdapterState,
): void {
  // ALWAYS emit message_start for every assistant message.
  // handleMessageStart calls resetAssistantMessageState() which MUST fire
  // before any handleMessageUpdate (thinking or text) events.
  emitMessageStart(fullMessage, emit, messageId, state);

  for (const block of content) {
    if (block.type === "thinking") {
      translateThinkingBlock(block, fullMessage, emit, messageId, state);
    } else if (block.type === "text") {
      translateTextBlock(block, fullMessage, emit, messageId, state);
    }
    // tool_use blocks: events are emitted by MCP tool server handler, not here.
    // The handler's handleToolExecutionStart calls flushBlockReplyBuffer() +
    // onBlockReplyFlush() when it receives tool_execution_start, so no flush
    // event needs to be emitted here.
  }

  // ALWAYS emit message_end to close the message lifecycle.
  // This ensures text is finalized BEFORE any tool_execution_start from the
  // MCP handler (which runs after the async generator yields the next message).
  emitMessageEnd(fullMessage, emit, messageId, state);
}

// ---------------------------------------------------------------------------
// Thinking block translation
// ---------------------------------------------------------------------------

function translateThinkingBlock(
  block: { type: "thinking"; thinking: string },
  fullMessage: {
    role: string;
    content: SdkContentBlock[];
    usage?: unknown;
    model?: string;
    stop_reason?: string;
  },
  emit: (evt: EmbeddedPiSubscribeEvent) => void,
  messageId: string,
  state: ClaudeSdkEventAdapterState,
): void {
  const thinkingText = block.thinking ?? "";

  // Build AgentMessage-compatible object with structured thinking content
  const thinkingMessage = buildAgentMessage(
    fullMessage,
    [{ type: "thinking", thinking: thinkingText }],
    messageId,
    state,
  );

  // thinking_start
  emit({
    type: "message_update",
    message: thinkingMessage,
    assistantMessageEvent: { type: "thinking_start" },
  } as EmbeddedPiSubscribeEvent);

  // thinking_delta (full text as single delta — SDK gives us complete block, not streaming)
  emit({
    type: "message_update",
    message: thinkingMessage,
    assistantMessageEvent: {
      type: "thinking_delta",
      delta: thinkingText,
      content: thinkingText,
    },
  } as EmbeddedPiSubscribeEvent);

  // thinking_end
  emit({
    type: "message_update",
    message: thinkingMessage,
    assistantMessageEvent: { type: "thinking_end" },
  } as EmbeddedPiSubscribeEvent);
}

// ---------------------------------------------------------------------------
// Text block translation
// ---------------------------------------------------------------------------

function translateTextBlock(
  block: { type: "text"; text: string },
  fullMessage: {
    role: string;
    content: SdkContentBlock[];
    usage?: unknown;
    model?: string;
    stop_reason?: string;
  },
  emit: (evt: EmbeddedPiSubscribeEvent) => void,
  messageId: string,
  state: ClaudeSdkEventAdapterState,
): void {
  const text = block.text ?? "";
  const textMessage = buildAgentMessage(fullMessage, [{ type: "text", text }], messageId, state);

  // text_delta — full text as single delta (SDK gives complete block at once)
  emit({
    type: "message_update",
    message: textMessage,
    assistantMessageEvent: {
      type: "text_delta",
      delta: text,
      content: text,
    },
  } as EmbeddedPiSubscribeEvent);

  // text_end — emitted with empty delta so deltaBuffer isn't double-appended.
  // Required for blockReplyBreak="text_end" consumers: handleMessageUpdate in
  // pi-embedded-subscribe.handlers.messages.ts calls flushBlockReplyBuffer() only
  // when evtType === "text_end". Without this, the flush fires at message_end
  // instead — functionally correct but diverges from Pi's streaming timing.
  // The handler's text_end branch sees deltaBuffer === content, computes
  // chunk = "" (no new text added), then executes the flush.
  emit({
    type: "message_update",
    message: textMessage,
    assistantMessageEvent: {
      type: "text_end",
      delta: "", // empty — deltaBuffer already holds the full text from text_delta
      content: text, // full content for the handler's monotonic suffix check
    },
  } as EmbeddedPiSubscribeEvent);
}

// ---------------------------------------------------------------------------
// Lifecycle event helpers
// ---------------------------------------------------------------------------

function emitMessageStart(
  fullMessage: {
    role: string;
    content: SdkContentBlock[];
    usage?: unknown;
    model?: string;
    stop_reason?: string;
  },
  emit: (evt: EmbeddedPiSubscribeEvent) => void,
  messageId: string,
  state: ClaudeSdkEventAdapterState,
): void {
  const message = buildAgentMessage(fullMessage, fullMessage.content, messageId, state);
  emit({
    type: "message_start",
    message,
  } as EmbeddedPiSubscribeEvent);
}

function emitMessageEnd(
  fullMessage: {
    role: string;
    content: SdkContentBlock[];
    usage?: unknown;
    model?: string;
    stop_reason?: string;
  },
  emit: (evt: EmbeddedPiSubscribeEvent) => void,
  messageId: string,
  state: ClaudeSdkEventAdapterState,
): void {
  const message = buildAgentMessage(fullMessage, fullMessage.content, messageId, state);
  emit({
    type: "message_end",
    message,
  } as EmbeddedPiSubscribeEvent);
}

// ---------------------------------------------------------------------------
// AgentMessage builder
// Constructs an AgentMessage-compatible object from an SDK assistant message.
// The handlers expect AgentMessage shape from @mariozechner/pi-agent-core.
// ---------------------------------------------------------------------------

function buildAgentMessage(
  sdkMessage: {
    role: string;
    content?: unknown;
    usage?: unknown;
    model?: string;
    stop_reason?: string;
    stopReason?: string;
    errorMessage?: string;
  },
  content: unknown[],
  messageId: string,
  state: Pick<ClaudeSdkEventAdapterState, "transcriptProvider" | "transcriptApi">,
): unknown {
  const stopReason = normalizeStopReason(sdkMessage.stop_reason ?? sdkMessage.stopReason);
  return {
    role: sdkMessage.role,
    content,
    usage: sdkMessage.usage,
    id: messageId,
    provider: state.transcriptProvider,
    api: state.transcriptApi,
    model: sdkMessage.model,
    stopReason,
    errorMessage: sdkMessage.errorMessage,
  };
}

function normalizeStopReason(value: unknown, fallback?: PiStopReason): PiStopReason | undefined {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  switch (normalized) {
    case "stop":
    case "end_turn":
    case "endturn":
    case "stop_sequence":
    case "stopsequence":
      return "stop";
    case "length":
    case "max_tokens":
    case "max_token":
    case "max_output_tokens":
      return "length";
    case "tooluse":
    case "tool_use":
    case "toolcall":
    case "tool_call":
    case "tool_calls":
      return "toolUse";
    case "error":
      return "error";
    case "aborted":
    case "abort":
    case "cancelled":
    case "canceled":
    case "interrupted":
      return "aborted";
    default:
      return fallback ?? "stop";
  }
}

function toTokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function calculateUsageCost(tokens: number, ratePerMillion?: number): number {
  if (typeof ratePerMillion !== "number" || !Number.isFinite(ratePerMillion)) {
    return 0;
  }
  return (tokens * ratePerMillion) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Stream event handler
// Translates Anthropic streaming events to Pi's event format for real-time UI.
// ---------------------------------------------------------------------------

function handleStreamEvent(
  event: SdkStreamEvent,
  state: ClaudeSdkEventAdapterState,
  emit: (evt: EmbeddedPiSubscribeEvent) => void,
): void {
  switch (event.type) {
    case "message_start": {
      const messageId = allocateMessageId(state, event.message);
      state.streamingPartialMessage = {
        role: "assistant",
        content: [],
        usage: event.message.usage,
        model: event.message.model,
      };
      state.streamingMessageId = messageId;
      state.streamingBlockTypes.clear();
      state.streamingInProgress = true;
      const message = buildAgentMessage(state.streamingPartialMessage, [], messageId, state);
      emit({ type: "message_start", message } as EmbeddedPiSubscribeEvent);
      break;
    }

    case "content_block_start": {
      const blockType = event.content_block.type;
      state.streamingBlockTypes.set(event.index, blockType);
      if (blockType === "thinking") {
        const message = buildAgentMessage(
          state.streamingPartialMessage ?? { role: "assistant" },
          state.streamingPartialMessage?.content ?? [],
          state.streamingMessageId ?? allocateMessageId(state),
          state,
        );
        emit({
          type: "message_update",
          message,
          assistantMessageEvent: { type: "thinking_start" },
        } as EmbeddedPiSubscribeEvent);
      } else if (blockType === "text") {
        // text_start is implicit — first text_delta serves as start.
        // No explicit event needed here.
      } else if (blockType === "tool_use" && state.streamingPartialMessage) {
        // Accumulate tool_use blocks so streamingPartialMessage.content mirrors
        // the final assistant message structure (no sparse array holes at tool_use
        // indices). This duplicates what the SDK does internally — tool execution
        // itself is still handled by the MCP tool server after the complete
        // assistant message arrives.
        const cb = event.content_block as { id?: string; name?: string };
        initToolUseBlock(state.streamingPartialMessage, event.index, cb.id ?? "", cb.name ?? "");
      }
      break;
    }

    case "content_block_delta": {
      if (!state.streamingPartialMessage) {
        break;
      }
      const deltaType = event.delta.type;

      if (deltaType === "text_delta" && event.delta.text !== undefined) {
        accumulateTextDelta(state.streamingPartialMessage, event.index, event.delta.text);
        const accumulated = getAccumulatedText(state.streamingPartialMessage, event.index);
        const message = buildAgentMessage(
          state.streamingPartialMessage,
          state.streamingPartialMessage.content,
          state.streamingMessageId ?? allocateMessageId(state),
          state,
        );
        emit({
          type: "message_update",
          message,
          assistantMessageEvent: {
            type: "text_delta",
            delta: event.delta.text,
            content: accumulated,
          },
        } as EmbeddedPiSubscribeEvent);
      } else if (deltaType === "thinking_delta" && event.delta.thinking !== undefined) {
        accumulateThinkingDelta(state.streamingPartialMessage, event.index, event.delta.thinking);
        const accumulated = getAccumulatedThinking(state.streamingPartialMessage, event.index);
        const message = buildAgentMessage(
          state.streamingPartialMessage,
          state.streamingPartialMessage.content,
          state.streamingMessageId ?? allocateMessageId(state),
          state,
        );
        emit({
          type: "message_update",
          message,
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: event.delta.thinking,
            content: accumulated,
          },
        } as EmbeddedPiSubscribeEvent);
      } else if (deltaType === "input_json_delta" && event.delta.partial_json !== undefined) {
        accumulateToolInputDelta(
          state.streamingPartialMessage,
          event.index,
          event.delta.partial_json,
        );
      }
      break;
    }

    case "content_block_stop": {
      const blockType = state.streamingBlockTypes.get(event.index);
      if (!state.streamingPartialMessage) {
        break;
      }

      if (blockType === "text") {
        const accumulated = getAccumulatedText(state.streamingPartialMessage, event.index);
        const message = buildAgentMessage(
          state.streamingPartialMessage,
          state.streamingPartialMessage.content,
          state.streamingMessageId ?? allocateMessageId(state),
          state,
        );
        emit({
          type: "message_update",
          message,
          assistantMessageEvent: {
            type: "text_end",
            delta: "",
            content: accumulated,
          },
        } as EmbeddedPiSubscribeEvent);
      } else if (blockType === "thinking") {
        const message = buildAgentMessage(
          state.streamingPartialMessage,
          state.streamingPartialMessage.content,
          state.streamingMessageId ?? allocateMessageId(state),
          state,
        );
        emit({
          type: "message_update",
          message,
          assistantMessageEvent: { type: "thinking_end" },
        } as EmbeddedPiSubscribeEvent);
      } else if (blockType === "tool_use") {
        finalizeToolUseInput(state.streamingPartialMessage, event.index);
      }
      state.streamingBlockTypes.delete(event.index);
      break;
    }

    case "message_delta": {
      if (state.streamingPartialMessage) {
        const priorUsage =
          state.streamingPartialMessage.usage &&
          typeof state.streamingPartialMessage.usage === "object"
            ? (state.streamingPartialMessage.usage as Record<string, unknown>)
            : undefined;
        const deltaUsage =
          event.usage && typeof event.usage === "object"
            ? (event.usage as Record<string, unknown>)
            : undefined;
        if (priorUsage && deltaUsage) {
          state.streamingPartialMessage.usage = { ...priorUsage, ...deltaUsage };
        } else {
          state.streamingPartialMessage.usage = event.usage;
        }
        // Capture stop_reason so message_stop's buildAgentMessage can normalize it.
        if (event.delta.stop_reason != null) {
          state.streamingPartialMessage.stop_reason = event.delta.stop_reason;
        }
      }
      break;
    }

    case "message_stop": {
      const message = buildAgentMessage(
        state.streamingPartialMessage ?? { role: "assistant" },
        state.streamingPartialMessage?.content ?? [],
        state.streamingMessageId ?? allocateMessageId(state),
        state,
      );
      emit({ type: "message_end", message } as EmbeddedPiSubscribeEvent);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Content accumulation helpers
// Build up partial message content during streaming so that
// streamingPartialMessage.content mirrors the final assistant message
// structure for all block types (text, thinking, tool_use).
// Tool_use accumulation duplicates what the SDK tracks internally — tool
// execution itself is handled by the MCP tool server after the complete
// assistant message arrives via rememberPendingToolUses/consumePendingToolUse.
// ---------------------------------------------------------------------------

function accumulateTextDelta(partial: { content: unknown[] }, index: number, text: string): void {
  const existing = partial.content[index] as { type: string; text?: string } | undefined;
  if (existing && existing.type === "text") {
    existing.text = (existing.text ?? "") + text;
  } else {
    partial.content[index] = { type: "text", text };
  }
}

function accumulateThinkingDelta(
  partial: { content: unknown[] },
  index: number,
  thinking: string,
): void {
  const existing = partial.content[index] as { type: string; thinking?: string } | undefined;
  if (existing && existing.type === "thinking") {
    existing.thinking = (existing.thinking ?? "") + thinking;
  } else {
    partial.content[index] = { type: "thinking", thinking };
  }
}

function initToolUseBlock(
  partial: { content: unknown[] },
  index: number,
  id: string,
  name: string,
): void {
  partial.content[index] = { type: "tool_use", id, name, _inputJson: "", input: {} };
}

function accumulateToolInputDelta(
  partial: { content: unknown[] },
  index: number,
  json: string,
): void {
  const existing = partial.content[index] as { type: string; _inputJson?: string } | undefined;
  if (existing && existing.type === "tool_use") {
    existing._inputJson = (existing._inputJson ?? "") + json;
  }
}

function finalizeToolUseInput(partial: { content: unknown[] }, index: number): void {
  const existing = partial.content[index] as
    | { type: string; _inputJson?: string; input?: unknown }
    | undefined;
  if (existing && existing.type === "tool_use") {
    try {
      existing.input = JSON.parse(existing._inputJson || "{}");
    } catch {
      existing.input = {};
    }
    delete existing._inputJson;
  }
}

function getAccumulatedText(partial: { content: unknown[] }, index: number): string {
  const block = partial.content[index] as { type: string; text?: string } | undefined;
  return block?.type === "text" ? (block.text ?? "") : "";
}

function getAccumulatedThinking(partial: { content: unknown[] }, index: number): string {
  const block = partial.content[index] as { type: string; thinking?: string } | undefined;
  return block?.type === "thinking" ? (block.thinking ?? "") : "";
}

// ---------------------------------------------------------------------------
// JSONL persistence
// Converts SDK message to Pi AssistantMessage format and persists via sessionManager.
// ---------------------------------------------------------------------------

function persistAssistantMessage(
  sdkMessage: SdkAssistantMessage,
  content: SdkContentBlock[],
  state: ClaudeSdkEventAdapterState,
): void {
  if (!state.sessionManager?.appendMessage) {
    return;
  }

  try {
    const piContent = content.map((block) => {
      if (block.type === "tool_use") {
        return {
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: block.input,
        };
      }
      // text and thinking blocks pass through as-is (identical shape)
      return block;
    });

    const sdkUsage = sdkMessage.message.usage as
      | {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        }
      | undefined;
    const inputTokens = toTokenCount(sdkUsage?.input_tokens);
    const outputTokens = toTokenCount(sdkUsage?.output_tokens);
    const cacheReadTokens = toTokenCount(sdkUsage?.cache_read_input_tokens);
    const cacheWriteTokens = toTokenCount(sdkUsage?.cache_creation_input_tokens);
    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    const usageCost = {
      input: calculateUsageCost(inputTokens, state.modelCost?.input),
      output: calculateUsageCost(outputTokens, state.modelCost?.output),
      cacheRead: calculateUsageCost(cacheReadTokens, state.modelCost?.cacheRead),
      cacheWrite: calculateUsageCost(cacheWriteTokens, state.modelCost?.cacheWrite),
    };
    const usageCostTotal =
      usageCost.input + usageCost.output + usageCost.cacheRead + usageCost.cacheWrite;

    const piMessage = {
      role: "assistant" as const,
      content: piContent,
      api: state.transcriptApi,
      provider: state.transcriptProvider,
      model: sdkMessage.message.model ?? "",
      stopReason: normalizeStopReason(sdkMessage.message.stop_reason, "stop"),
      usage: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens,
        totalTokens,
        cost: {
          input: usageCost.input,
          output: usageCost.output,
          cacheRead: usageCost.cacheRead,
          cacheWrite: usageCost.cacheWrite,
          total: usageCostTotal,
        },
      },
      timestamp: Date.now(),
    };

    state.sessionManager.appendMessage(piMessage);
  } catch {
    // Persistence failure is non-fatal
  }
}
