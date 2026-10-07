import { randomUUID } from "node:crypto";
import { stripCompactionReplayCheckpointInPlace } from "@openclaw/ai/transports";
import type { StreamFn } from "../../runtime/index.js";
import { normalizeToolPolicyName } from "../../tool-policy.js";
import { isRunnerToolCallBlock } from "./attempt-tool-call-block-type.js";
import { resolveToolCallName } from "./attempt-tool-call-name-resolution.js";
import { mapAssistantMessageStream, wrapStreamObjectEvents } from "./stream-wrapper.js";

const BLANK_TOOL_CALL_NAME_DESCRIPTION = "blank tool name";
type UnknownToolLoopGuardState = {
  lastUnknownToolName?: string;
  count: number;
  countedMessages: WeakSet<object>;
};
type ToolCallMessageState =
  | undefined
  | { kind: "allowed" }
  | { kind: "incomplete" }
  | { kind: "malformed"; toolName: string }
  | { kind: "unknown"; toolName: string };
type AssistantStream = Awaited<ReturnType<StreamFn>>;

function normalizeToolCallsInMessage(
  message: unknown,
  allowedToolNames: Set<string> | undefined,
  fallbackIdByContentIndex: string[],
  earlierToolCallIds: ReadonlySet<string>,
  seenToolCallIds: Set<string>,
): ToolCallMessageState {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  // Collect every provider id before assigning fallbacks, including ids in later blocks.
  let usedIds: Set<string> | undefined;
  let unknownToolName: string | undefined;
  let sawAllowedToolCall = false;
  let sawIncompleteToolCall = false;
  let sawBlankStringToolCall = false;
  const hasAllowedToolNames = Boolean(allowedToolNames && allowedToolNames.size > 0);
  for (const block of content) {
    if (!isRunnerToolCallBlock(block)) {
      continue;
    }
    usedIds ??= new Set<string>();
    const rawId = typeof block.id === "string" ? block.id : undefined;
    const normalized = resolveToolCallName(
      typeof block.name === "string" ? block.name : "",
      allowedToolNames,
      rawId,
    );
    if (normalized && normalized !== block.name) {
      block.name = normalized;
    }
    const trimmedId = rawId?.trim();
    if (trimmedId) {
      usedIds.add(trimmedId);
    }

    const rawBlockName = block.name;
    const hasStringName = typeof rawBlockName === "string";
    const rawName = hasStringName ? rawBlockName.trim() : "";
    if (!rawName) {
      if (hasStringName) {
        sawBlankStringToolCall = true;
      } else {
        sawIncompleteToolCall = true;
      }
      continue;
    }
    if (!hasAllowedToolNames) {
      continue;
    }
    // Resolution above returns the exact allowed spelling, including aliases.
    if (hasStringName && allowedToolNames?.has(rawBlockName)) {
      sawAllowedToolCall = true;
      continue;
    }
    const normalizedUnknownToolName = normalizeToolPolicyName(rawName);
    if (!unknownToolName) {
      unknownToolName = normalizedUnknownToolName;
    } else if (unknownToolName !== normalizedUnknownToolName) {
      sawIncompleteToolCall = true;
    }
  }
  if (!usedIds) {
    return undefined;
  }

  const assignedIds = new Set<string>();
  for (const [contentIndex, block] of content.entries()) {
    if (!isRunnerToolCallBlock(block)) {
      continue;
    }
    const trimmedId = typeof block.id === "string" ? block.id.trim() : "";
    if (trimmedId && !earlierToolCallIds.has(trimmedId) && !assignedIds.has(trimmedId)) {
      if (block.id !== trimmedId) {
        block.id = trimmedId;
      }
      assignedIds.add(trimmedId);
      continue;
    }

    let fallbackId = fallbackIdByContentIndex[contentIndex];
    while (
      !fallbackId ||
      earlierToolCallIds.has(fallbackId) ||
      usedIds.has(fallbackId) ||
      assignedIds.has(fallbackId)
    ) {
      fallbackId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    }
    fallbackIdByContentIndex[contentIndex] = fallbackId;
    block.id = fallbackId;
    usedIds.add(fallbackId);
    assignedIds.add(fallbackId);
  }
  for (const id of assignedIds) {
    seenToolCallIds.add(id);
  }

  if (!hasAllowedToolNames) {
    return sawBlankStringToolCall
      ? { kind: "malformed", toolName: BLANK_TOOL_CALL_NAME_DESCRIPTION }
      : undefined;
  }
  if (sawAllowedToolCall) {
    return { kind: "allowed" };
  }
  if (sawBlankStringToolCall && !sawIncompleteToolCall && unknownToolName === undefined) {
    return { kind: "malformed", toolName: BLANK_TOOL_CALL_NAME_DESCRIPTION };
  }
  if (sawIncompleteToolCall) {
    return { kind: "incomplete" };
  }
  return unknownToolName ? { kind: "unknown", toolName: unknownToolName } : { kind: "incomplete" };
}

function rewriteUnknownToolLoopMessage(message: unknown, toolName: string): void {
  if (!message || typeof message !== "object") {
    return;
  }
  (message as { content?: unknown }).content = [
    {
      type: "text",
      text: `I can't use the tool "${toolName}" here because it isn't available. I need to stop retrying it and answer without that tool.`,
    },
  ];
  stripCompactionReplayCheckpointInPlace(message);
}

function guardUnknownToolLoopInMessage(
  message: unknown,
  toolCallState: ToolCallMessageState,
  state: UnknownToolLoopGuardState,
  params: {
    threshold?: number;
    countAttempt: boolean;
    projection: "partial" | "message" | "result";
  },
): boolean {
  if (toolCallState?.kind === "allowed") {
    if (params.projection !== "partial") {
      state.lastUnknownToolName = undefined;
      state.count = 0;
    }
    return false;
  }
  if (toolCallState?.kind === "malformed") {
    if (params.projection === "result") {
      rewriteUnknownToolLoopMessage(message, toolCallState.toolName);
      return true;
    }
    return false;
  }
  const threshold = params.threshold;
  if (threshold === undefined || threshold <= 0) {
    return false;
  }
  if (toolCallState?.kind !== "unknown") {
    if (params.countAttempt && params.projection === "result") {
      state.lastUnknownToolName = undefined;
      state.count = 0;
    }
    return false;
  }
  const unknownToolName = toolCallState.toolName;

  const countableMessage = message && typeof message === "object" ? message : undefined;
  if (!params.countAttempt || (countableMessage && state.countedMessages.has(countableMessage))) {
    // Partial events and already-counted final projections may rewrite, but
    // only a new final message advances the loop counter.
    if (state.lastUnknownToolName === unknownToolName && state.count > threshold) {
      rewriteUnknownToolLoopMessage(message, unknownToolName);
    }
    return params.countAttempt;
  }
  if (countableMessage) {
    state.countedMessages.add(countableMessage);
  }

  state.count = state.lastUnknownToolName === unknownToolName ? state.count + 1 : 1;
  state.lastUnknownToolName = unknownToolName;

  if (state.count > threshold) {
    rewriteUnknownToolLoopMessage(message, unknownToolName);
  }
  return true;
}

function wrapStreamTrimToolCallNames(
  stream: AssistantStream,
  allowedToolNames: Set<string> | undefined,
  options: {
    unknownToolThreshold?: number;
    state: UnknownToolLoopGuardState;
    earlierToolCallIds: ReadonlySet<string>;
    seenToolCallIds: Set<string>;
  },
): AssistantStream {
  // Missing or colliding ids reuse one fallback per content position across
  // this response's partial/final projections; later responses get fresh ids.
  const fallbackIdByContentIndex: string[] = [];
  let streamAttemptAlreadyCounted = false;
  const normalize = (message: unknown) =>
    normalizeToolCallsInMessage(
      message,
      allowedToolNames,
      fallbackIdByContentIndex,
      options.earlierToolCallIds,
      options.seenToolCallIds,
    );
  const guard = (
    message: unknown,
    toolCallState: ToolCallMessageState,
    projection: "partial" | "message" | "result",
  ) =>
    guardUnknownToolLoopInMessage(message, toolCallState, options.state, {
      threshold: options.unknownToolThreshold,
      countAttempt: projection !== "partial" && !streamAttemptAlreadyCounted,
      projection,
    });
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    guard(message, normalize(message), "result");
    return message;
  };

  wrapStreamObjectEvents(stream, (event) => {
    const partialState = normalize(event.partial);
    const messageState = normalize(event.message);
    if (event.message && typeof event.message === "object") {
      const countedStreamAttempt = guard(event.message, messageState, "message");
      streamAttemptAlreadyCounted ||= countedStreamAttempt;
    }
    // The message guard already handles aliased partials and may replace their content.
    if (event.partial !== event.message) {
      guard(event.partial, partialState, "partial");
    }
  });

  return stream;
}

export function wrapStreamFnTrimToolCallNames(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
  guardOptions?: { unknownToolThreshold?: number },
): StreamFn {
  const unknownToolGuardState: UnknownToolLoopGuardState = {
    count: 0,
    countedMessages: new WeakSet<object>(),
  };
  // Kimi via opencode resets ids each response; retain seen ids across compaction.
  const seenToolCallIds = new Set<string>();
  return (model, context, streamOptions) => {
    for (const message of context.messages ?? []) {
      if (message.role !== "assistant") {
        continue;
      }
      for (const block of message.content) {
        if (isRunnerToolCallBlock(block) && typeof block.id === "string" && block.id.trim()) {
          seenToolCallIds.add(block.id.trim());
        }
      }
    }
    const earlierToolCallIds = new Set(seenToolCallIds);
    return mapAssistantMessageStream(baseFn(model, context, streamOptions), (stream) =>
      wrapStreamTrimToolCallNames(stream, allowedToolNames, {
        unknownToolThreshold: guardOptions?.unknownToolThreshold,
        state: unknownToolGuardState,
        earlierToolCallIds,
        seenToolCallIds,
      }),
    );
  };
}
