import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createReasoningTagTextPartitioner,
  scanReasoningTags,
  type ReasoningTagTextDelta,
} from "../../packages/markdown-core/src/reasoning-tags.js";
import type { CliBackendConfig, CliBackendParsedJsonlEvent } from "../plugins/cli-backend.types.js";
import type {
  CliOutput,
  CliStreamingDelta,
  CliThinkingDelta,
  CliThinkingProgress,
  CliToolResultDelta,
  CliToolUseStartDelta,
  CliUsage,
} from "./cli-output-contracts.js";
import {
  isClaudeSubagentRecord,
  isClaudeToolResultBlockType,
  isClaudeToolUseBlockType,
  isGeminiStreamJsonDialect,
  supportsCliJsonlToolEvents,
} from "./cli-output-records.js";
import {
  appendPendingToolInput,
  beginPendingToolUse,
  emitToolResultOnce,
  emitToolStartOnce,
  releasePendingToolUse,
  type ToolUseTracker,
} from "./cli-output-tool-tracker.js";

export type CliEventProjectionState = {
  assistantText: string;
  customThinkingText: string;
  sessionId?: string;
  usage?: CliUsage;
  output: CliOutput | null;
  sawCustomJsonlEvent: boolean;
};

export function projectCliBackendEvent(params: {
  event: CliBackendParsedJsonlEvent;
  state: CliEventProjectionState;
  texts: string[];
  toolTracker: ToolUseTracker;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onThinkingDelta?: (delta: CliThinkingDelta) => void;
  onDisplayToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onDisplayToolResult?: (delta: CliToolResultDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
  onSessionId?: (sessionId: string) => void;
  onUsage?: (usage: CliUsage, terminal: boolean) => void;
}): void {
  const { event, state } = params;
  if (state.output?.errorText && event.kind !== "sessionId" && event.kind !== "result") {
    return;
  }
  state.sawCustomJsonlEvent = true;
  if (event.kind === "sessionId") {
    const sessionId = event.sessionId.trim();
    if (sessionId && sessionId !== state.sessionId) {
      state.sessionId = sessionId;
      params.onSessionId?.(sessionId);
    }
    if (state.output) {
      state.output = { ...state.output, sessionId: state.sessionId };
    }
    return;
  }
  if (event.kind === "text") {
    if (!event.text) {
      return;
    }
    state.assistantText += event.text;
    params.onAssistantDelta({
      text: state.assistantText,
      delta: event.text,
      sessionId: state.sessionId,
      usage: state.usage,
    });
    return;
  }
  if (event.kind === "thinking") {
    if (!event.text || !params.onThinkingDelta) {
      return;
    }
    state.customThinkingText += event.text;
    params.onThinkingDelta({
      text: state.customThinkingText,
      delta: event.text,
      isReasoningSnapshot: true,
    });
    return;
  }
  if (event.kind === "toolStart") {
    emitToolStartOnce(
      params.toolTracker,
      event.toolCallId,
      event.name,
      "tool_use",
      event.args ?? {},
      params.onDisplayToolUseStart ?? params.onToolUseStart,
    );
    return;
  }
  if (event.kind === "toolResult") {
    if (event.name) {
      params.toolTracker.nameById.set(event.toolCallId, event.name);
    }
    emitToolResultOnce(
      params.toolTracker,
      event.toolCallId,
      event.isError === true,
      event.result,
      params.onDisplayToolResult ?? params.onToolResult,
    );
    return;
  }
  const normalizedSessionId = event.sessionId?.trim();
  if (normalizedSessionId && normalizedSessionId !== state.sessionId) {
    state.sessionId = normalizedSessionId;
    params.onSessionId?.(normalizedSessionId);
  }
  if (event.usage) {
    state.usage = event.usage;
    params.onUsage?.(event.usage, true);
  }
  const existingErrorText = state.output?.errorText;
  // Stop at the authoritative winner before composing fallback transcripts.
  const resultText =
    (!existingErrorText && event.text?.trim()) ||
    state.output?.text.trim() ||
    params.texts.join("\n").trim() ||
    state.assistantText.trim();
  const errorText = existingErrorText || event.errorText;
  state.output = {
    ...state.output,
    text: resultText,
    sessionId: state.sessionId,
    usage: state.usage,
    ...(errorText ? { errorText } : {}),
  };
}

export function projectCliTaggedReasoning(params: {
  deltas: readonly ReasoningTagTextDelta[];
  currentText: string;
  hasNativeThinking: boolean;
  onThinkingDelta?: (delta: CliThinkingDelta) => void;
  onVisibleText: (text: string) => void;
}): string {
  let text = params.currentText;
  for (const delta of params.deltas) {
    if (delta.kind === "text") {
      params.onVisibleText(delta.text);
      continue;
    }
    text += delta.text;
    if (!params.hasNativeThinking) {
      params.onThinkingDelta?.({
        text,
        delta: delta.text,
        isReasoningSnapshot: true,
      });
    }
  }
  return text;
}

function isClaudeAssistantToolResultBlockType(type: unknown): boolean {
  return isClaudeToolResultBlockType(type) && type !== "tool_result";
}

function isClaudeToolResultError(content: unknown): boolean {
  return isRecord(content) && typeof content.type === "string" && content.type.endsWith("_error");
}

function emitClaudeToolResultBlock(
  tracker: ToolUseTracker,
  block: Record<string, unknown>,
  onToolResult: ((delta: CliToolResultDelta) => void) | undefined,
): void {
  const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id.trim() : "";
  if (toolCallId) {
    emitToolResultOnce(
      tracker,
      toolCallId,
      block.is_error === true ||
        (block.type !== "tool_result" && isClaudeToolResultError(block.content)),
      block.content,
      onToolResult,
    );
  }
}

export function dispatchClaudeCliStreamingToolEvent(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
  tracker: ToolUseTracker;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
}): void {
  if (!supportsCliJsonlToolEvents(params) || isClaudeSubagentRecord(params.parsed)) {
    return;
  }
  const tracker = params.tracker;

  if (params.parsed.type === "stream_event" && isRecord(params.parsed.event)) {
    const event = params.parsed.event;
    if (
      event.type === "content_block_start" &&
      typeof event.index === "number" &&
      isRecord(event.content_block)
    ) {
      const block = event.content_block;
      if (isClaudeToolUseBlockType(block.type)) {
        const toolCallId = typeof block.id === "string" ? block.id.trim() : "";
        const name = typeof block.name === "string" ? block.name.trim() : "";
        if (toolCallId && name) {
          beginPendingToolUse(tracker, event.index, {
            toolCallId,
            name,
            kind: block.type,
            ...(isRecord(block.input) ? { blockInput: block.input } : {}),
          });
        }
      } else if (isClaudeAssistantToolResultBlockType(block.type)) {
        emitClaudeToolResultBlock(tracker, block, params.onToolResult);
      }
      return;
    }
    if (
      event.type === "content_block_delta" &&
      typeof event.index === "number" &&
      isRecord(event.delta)
    ) {
      if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
        appendPendingToolInput(tracker, event.index, event.delta.partial_json);
      }
      return;
    }
    if (event.type === "content_block_stop" && typeof event.index === "number") {
      const pending = releasePendingToolUse(tracker, event.index);
      if (pending) {
        // Delta presence, not key count, decides the winner: a no-argument call
        // arrives as an explicit `{}` delta, so keying on key count would let the
        // start snapshot overwrite it.
        const args =
          pending.inputJsonParts.length > 0
            ? (safeParseJsonRecord(pending.inputJsonParts.join("")) ?? {})
            : (pending.blockInput ?? {});
        emitToolStartOnce(
          tracker,
          pending.toolCallId,
          pending.name,
          pending.kind,
          args,
          params.onToolUseStart,
        );
      }
      return;
    }
    return;
  }

  const assistant = params.parsed.type === "assistant";
  if ((assistant || params.parsed.type === "user") && isRecord(params.parsed.message)) {
    const message = params.parsed.message;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      if (assistant && isClaudeToolUseBlockType(block.type)) {
        const toolCallId = typeof block.id === "string" ? block.id.trim() : "";
        const name = typeof block.name === "string" ? block.name.trim() : "";
        if (toolCallId && name) {
          const args = isRecord(block.input) ? block.input : {};
          emitToolStartOnce(tracker, toolCallId, name, block.type, args, params.onToolUseStart);
        }
      } else if (
        assistant ? isClaudeAssistantToolResultBlockType(block.type) : block.type === "tool_result"
      ) {
        emitClaudeToolResultBlock(tracker, block, params.onToolResult);
      }
    }
  }
}

type ThinkingTracker = {
  currentMessageId?: string;
  // Thinking text already streamed via thinking_delta, keyed by the Anthropic
  // content-block index. Snapshot frames repeat streamed thinking, so each block
  // is deduped against its own index; a single global concatenation misfires
  // once a message carries more than one thinking block (re-emits or reorders).
  streamedByIndex: Map<number, string>;
  highestStreamedIndex: number;
  // Full thinking already emitted for the message in block order. The callback
  // contract exposes this as the running snapshot text for downstream coalescing,
  // so it stays a message-level concatenation, not a per-index value.
  emittedText: string;
  currentSyntheticBlockIndex?: number;
  nextSyntheticBlockIndex: number;
  progressTokens: number;
};

export function createThinkingTracker(): ThinkingTracker {
  return {
    streamedByIndex: new Map(),
    highestStreamedIndex: Number.NEGATIVE_INFINITY,
    emittedText: "",
    nextSyntheticBlockIndex: 0,
    progressTokens: 0,
  };
}

function resetThinkingBlockState(tracker: ThinkingTracker): void {
  tracker.streamedByIndex.clear();
  tracker.highestStreamedIndex = Number.NEGATIVE_INFINITY;
  tracker.emittedText = "";
  tracker.currentSyntheticBlockIndex = undefined;
  tracker.nextSyntheticBlockIndex = 0;
  tracker.progressTokens = 0;
}

function resetThinkingTrackerForMessage(
  tracker: ThinkingTracker,
  messageId: string | undefined,
): void {
  if (messageId && messageId === tracker.currentMessageId) {
    return;
  }
  if (messageId && tracker.currentMessageId === undefined) {
    tracker.currentMessageId = messageId;
    return;
  }
  // Anthropic content-block indexes restart at 0 for each message, so a prior
  // tool-round message's per-index thinking must not bleed into the next one.
  resetThinkingBlockState(tracker);
  tracker.currentMessageId = messageId;
}

function beginClaudeContentBlock(tracker: ThinkingTracker, index: unknown): void {
  tracker.currentSyntheticBlockIndex =
    index === undefined
      ? tracker.nextSyntheticBlockIndex++
      : (resolveClaudeContentBlockIndex(tracker, index) ?? undefined);
}

function resolveClaudeContentBlockIndex(tracker: ThinkingTracker, index: unknown): number | null {
  if (typeof index === "number") {
    tracker.nextSyntheticBlockIndex = Math.max(tracker.nextSyntheticBlockIndex, index + 1);
    return index;
  }
  if (index !== undefined) {
    return null;
  }
  return tracker.currentSyntheticBlockIndex ?? null;
}

function assembleThinkingTextByIndex(streamedByIndex: Map<number, string>): string {
  return [...streamedByIndex.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, text]) => text)
    .join("");
}

function emitClaudeThinking(
  tracker: ThinkingTracker,
  index: number,
  streamed: string,
  delta: string,
  onThinkingDelta: (delta: CliThinkingDelta) => void,
): void {
  const appendToAggregate = index >= tracker.highestStreamedIndex;
  tracker.streamedByIndex.set(index, `${streamed}${delta}`);
  tracker.highestStreamedIndex = Math.max(tracker.highestStreamedIndex, index);
  tracker.emittedText = appendToAggregate
    ? `${tracker.emittedText}${delta}`
    : assembleThinkingTextByIndex(tracker.streamedByIndex);
  onThinkingDelta({ text: tracker.emittedText, delta, isReasoningSnapshot: true });
}

function readThinkingProgressTokens(delta: Record<string, unknown>): number | undefined {
  if (delta.type !== "thinking_delta" || delta.thinking !== "") {
    return undefined;
  }
  return asPositiveFiniteNumber(delta.estimated_tokens);
}

export function dispatchClaudeCliThinking(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
  tracker: ThinkingTracker;
  onThinkingDelta?: (delta: CliThinkingDelta) => void;
  onThinkingProgress?: (progress: CliThinkingProgress) => void;
}): void {
  if (!supportsCliJsonlToolEvents(params) || isClaudeSubagentRecord(params.parsed)) {
    return;
  }
  const tracker = params.tracker;

  if (params.parsed.type === "stream_event" && isRecord(params.parsed.event)) {
    const event = params.parsed.event;
    if (event.type === "message_start") {
      const message = isRecord(event.message) ? event.message : undefined;
      resetThinkingTrackerForMessage(
        tracker,
        typeof message?.id === "string" ? message.id : undefined,
      );
      return;
    }
    if (event.type === "content_block_start") {
      beginClaudeContentBlock(tracker, event.index);
      return;
    }
    if (event.type === "content_block_stop") {
      tracker.currentSyntheticBlockIndex = undefined;
      return;
    }
    if (event.type !== "content_block_delta" || !isRecord(event.delta)) {
      return;
    }
    // Thinking state is per content-block; when the CLI omits indexes, the
    // surrounding block start/stop stream supplies the ordering slot.
    const blockIndex = resolveClaudeContentBlockIndex(tracker, event.index);
    if (blockIndex === null) {
      return;
    }
    const progressTokensDelta = readThinkingProgressTokens(event.delta);
    const onThinkingProgress = params.onThinkingProgress;
    if (progressTokensDelta !== undefined && onThinkingProgress) {
      tracker.progressTokens += progressTokensDelta;
      onThinkingProgress({ progressTokens: tracker.progressTokens });
      return;
    }
    // signature_delta carries opaque continuation material; the Claude CLI owns
    // its own session transcript, so it never enters the thinking text lane.
    if (event.delta.type !== "thinking_delta" || typeof event.delta.thinking !== "string") {
      return;
    }
    if (!event.delta.thinking || !params.onThinkingDelta) {
      return;
    }
    const streamed = tracker.streamedByIndex.get(blockIndex) ?? "";
    emitClaudeThinking(tracker, blockIndex, streamed, event.delta.thinking, params.onThinkingDelta);
    return;
  }

  if (params.parsed.type === "assistant" && isRecord(params.parsed.message)) {
    resetThinkingTrackerForMessage(
      tracker,
      typeof params.parsed.message.id === "string" ? params.parsed.message.id : undefined,
    );
    const content = Array.isArray(params.parsed.message.content)
      ? params.parsed.message.content
      : [];
    for (const [index, block] of content.entries()) {
      // redacted_thinking blocks are opaque provider material with no text lane.
      if (!isRecord(block) || block.type !== "thinking" || typeof block.thinking !== "string") {
        continue;
      }
      if (!params.onThinkingDelta) {
        continue;
      }
      tracker.streamedByIndex.set(index, block.thinking);
      tracker.highestStreamedIndex = Math.max(tracker.highestStreamedIndex, index);
      const text = assembleThinkingTextByIndex(tracker.streamedByIndex);
      if (text === tracker.emittedText) {
        continue;
      }
      tracker.emittedText = text;
      params.onThinkingDelta({ text, delta: block.thinking, isReasoningSnapshot: true });
    }
  }
}

export function dispatchGeminiCliStreamingToolEvent(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
  tracker: ToolUseTracker;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
}): void {
  if (!isGeminiStreamJsonDialect(params)) {
    return;
  }
  if (params.parsed.type === "tool_use") {
    const toolCallId =
      typeof params.parsed.tool_id === "string" ? params.parsed.tool_id.trim() : "";
    const name = typeof params.parsed.tool_name === "string" ? params.parsed.tool_name.trim() : "";
    if (!toolCallId || !name) {
      return;
    }
    const args = isRecord(params.parsed.parameters) ? params.parsed.parameters : {};
    emitToolStartOnce(params.tracker, toolCallId, name, "tool_use", args, params.onToolUseStart);
    return;
  }
  if (params.parsed.type === "tool_result") {
    const toolCallId =
      typeof params.parsed.tool_id === "string" ? params.parsed.tool_id.trim() : "";
    if (!toolCallId) {
      return;
    }
    const result =
      params.parsed.status === "error" && isRecord(params.parsed.error)
        ? params.parsed.error
        : params.parsed.output;
    emitToolResultOnce(
      params.tracker,
      toolCallId,
      params.parsed.status === "error",
      result,
      params.onToolResult,
    );
  }
}

export function partitionLeadingTaggedReasoning(
  text: string,
  final: boolean,
):
  | { pending: true; openWithoutPendingTag: boolean }
  | { pending: false; reasoningText: string; visibleText: string } {
  const first = text.search(/\S/u);
  if (first === -1) {
    return final
      ? { pending: false, reasoningText: "", visibleText: text }
      : { pending: true, openWithoutPendingTag: false };
  }
  if (text.charAt(first) !== "<") {
    return { pending: false, reasoningText: "", visibleText: text };
  }

  const scan = scanReasoningTags(text, final);
  let depth = 0;
  let end = -1;
  for (const tag of scan.tags) {
    if (depth === 0) {
      const expectedStart = end === -1 ? first : end;
      if (text.slice(expectedStart, tag.index).trim() || tag.isClose || tag.isSelfClosing) {
        break;
      }
    }
    depth += tag.isClose ? -1 : tag.isSelfClosing ? 0 : 1;
    if (depth === 0 && tag.isClose) {
      end = tag.index + tag.text.length;
    }
  }

  const pendingTagAfterBlock =
    end !== -1 && scan.pendingStart !== undefined && !text.slice(end, scan.pendingStart).trim();
  if (end === -1) {
    const pendingLeadingTag =
      scan.pendingStart !== undefined && !text.slice(first, scan.pendingStart).trim();
    return !final && (depth > 0 || pendingLeadingTag)
      ? { pending: true, openWithoutPendingTag: depth > 0 && scan.pendingStart === undefined }
      : { pending: false, reasoningText: "", visibleText: text };
  }
  if (!final && (depth > 0 || pendingTagAfterBlock || !text.slice(end).trim())) {
    return { pending: true, openWithoutPendingTag: depth > 0 && scan.pendingStart === undefined };
  }

  const partitioner = createReasoningTagTextPartitioner();
  const deltas = [...partitioner.pushVisible(text.slice(0, end)), ...partitioner.flush()];
  const reasoningText = deltas
    .filter((delta) => delta.kind === "thinking")
    .map((delta) => delta.text)
    .join("");
  return reasoningText
    ? { pending: false, reasoningText, visibleText: text.slice(end) }
    : { pending: false, reasoningText: "", visibleText: text };
}

export function createLeadingTaggedReasoningRouter() {
  let pending = "";
  let settled = false;
  let openWithoutPendingTag = false;
  const consume = (chunk: string, final: boolean): ReasoningTagTextDelta[] => {
    if (settled) {
      return chunk ? [{ kind: "text", text: chunk }] : [];
    }
    pending += chunk;
    // Without an unfinished tag, only '<' can change the open lexical block.
    if (!final && openWithoutPendingTag && !chunk.includes("<")) {
      return [];
    }
    const result = partitionLeadingTaggedReasoning(pending, final);
    if (result.pending) {
      openWithoutPendingTag = result.openWithoutPendingTag;
      return [];
    }
    settled = true;
    pending = "";
    return [
      ...(result.reasoningText
        ? ([{ kind: "thinking", text: result.reasoningText }] as const)
        : []),
      ...(result.visibleText ? ([{ kind: "text", text: result.visibleText }] as const) : []),
    ];
  };
  return {
    push: (chunk: string) => consume(chunk, false),
    finish: () => consume("", true),
  };
}
