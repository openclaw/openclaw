import type { AgentMessage } from "@openclaw/agent-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  classifyToolPairingFacts,
  resolveLegacyToolResultId,
  type ToolCallLike,
} from "../../packages/agent-core/src/harness/session/tool-pairing-facts.js";
import {
  type classifyToolUseResultPairing,
  extractToolCallsFromAssistant,
} from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import {
  agentMessageToolReplayAdapter,
  createCompletedToolCallPredicateWithAdapter,
  isAllowedToolCallName,
  normalizeAllowedToolNames,
  replayToolResultIds,
  type ReplayToolResultUpdate,
  type ToolReplayAdapter,
} from "./tool-call-shared.js";

export { makeMissingToolResult } from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";
export { stripToolResultDetails } from "../shared/model-context-message.js";

export type ToolCallInputRepairOptions = {
  allowedToolNames?: Iterable<string>;
  allowProviderOwnedThinkingReplay?: boolean;
};

type ErroredAssistantResultPolicy = "preserve" | "drop";

type ReplayToolPairingFrame<Message> = {
  startIndex: number;
  endIndex: number;
  assistant: Message;
  remainder: Message[];
  occurrences: Array<ToolCallLike & { result?: Message }>;
  failed: boolean;
};

export type ToolUseResultPairingAdapterOptions<Message> = {
  pairing?: ReplayToolPairingFrame<Message>[];
  erroredAssistantResultPolicy?: ErroredAssistantResultPolicy;
  missingToolResultText?: string;
  missingToolResultTimestamp?: "assistant";
  // Only the Responses replay owner may retain unframed results across checkpoints.
  preserveUnframedToolResults?: boolean;
};

type ToolUseResultPairingOptions = Omit<
  ToolUseResultPairingAdapterOptions<AgentMessage>,
  "pairing"
> & {
  pairing?: ReturnType<typeof classifyToolUseResultPairing>;
};

function collectFollowingToolResultsWithAdapter<Message, Block>(
  messages: readonly Message[],
  index: number,
  adapter: ToolReplayAdapter<Message, Block>,
  currentToolCalls?: ToolCallLike[],
  hasAssistantToolCall = (message: Message) => {
    const pairing = adapter.pairing(message);
    return pairing?.role === "assistant" && pairing.calls.length > 0;
  },
): { ids: Set<string>; displaced: boolean } {
  const ids = new Set<string>();
  let sawNonToolResult = false;
  let displaced = false;
  for (let nextIndex = index + 1; nextIndex < messages.length; nextIndex += 1) {
    const message = messages[nextIndex]!;
    if (!adapter.valid(message)) {
      sawNonToolResult = true;
      continue;
    }
    const role = adapter.role(message);
    if (role === "assistant" && hasAssistantToolCall(message)) {
      break;
    }
    if (role === "toolResult") {
      let result = adapter.result(message);
      if (currentToolCalls) {
        const id = replayToolResultIds(result)[0] ?? null;
        const resolved = resolveLegacyToolResultId(id, result.name, currentToolCalls);
        if (resolved !== null && resolved !== id) {
          result = { ...result, ids: { ...result.ids, toolCallId: resolved } };
        }
      }
      const resultIds = replayToolResultIds(result);
      for (const id of resultIds) {
        ids.add(id);
      }
      displaced ||= resultIds.length > 0 && sawNonToolResult;
      continue;
    }
    sawNonToolResult = true;
  }
  return { ids, displaced };
}

export function collectFollowingToolResults(
  messages: AgentMessage[],
  index: number,
  currentToolCalls?: ReturnType<typeof extractToolCallsFromAssistant>,
  hasAssistantToolCall = (message: Extract<AgentMessage, { role: "assistant" }>) =>
    extractToolCallsFromAssistant(message).length > 0,
): { ids: Set<string>; displaced: boolean } {
  return collectFollowingToolResultsWithAdapter(
    messages,
    index,
    agentMessageToolReplayAdapter,
    currentToolCalls,
    (message) => message.role === "assistant" && hasAssistantToolCall(message),
  );
}

/** One filtering owner for payload arrays and row-local metadata inventories. */
export function sanitizeToolCallInputsWithAdapter<Message, Block>(
  messages: Message[],
  adapter: ToolReplayAdapter<Message, Block>,
  options?: ToolCallInputRepairOptions,
): Message[] {
  let changed = false;
  const out: Message[] = [];
  const allowedToolNames = normalizeAllowedToolNames(options?.allowedToolNames);
  const isCompleted = createCompletedToolCallPredicateWithAdapter(messages, adapter);
  const preservedThinkingToolCallIds = new Set<string>();
  const priorToolCallIds = new Set<string>();

  for (const [index, message] of messages.entries()) {
    if (!adapter.valid(message)) {
      changed = true;
      continue;
    }
    const content = adapter.content(message);
    if (adapter.role(message) !== "assistant" || !content) {
      out.push(message);
      continue;
    }
    const blockFacts =
      options?.allowProviderOwnedThinkingReplay === true
        ? content.map((block) => adapter.block(message, block))
        : undefined;
    if (blockFacts?.some((facts) => facts.thinking) && blockFacts.some((facts) => facts.toolCall)) {
      const pairing = adapter.pairing(message);
      const toolCalls = pairing?.role === "assistant" ? pairing.calls : [];
      const following = collectFollowingToolResultsWithAdapter(messages, index, adapter, toolCalls);
      const hasSpawnAttachments = blockFacts.some(
        (facts) => facts.toolCall && facts.name === "sessions_spawn" && facts.hasInputAttachments,
      );
      const seen = new Set<string>();
      const replaySafe = content.every((block, blockIndex) => {
        const facts = blockFacts[blockIndex]!;
        if (!facts.toolCall) {
          return true;
        }
        const id = facts.id?.trim();
        if (
          !facts.hasInput ||
          facts.hasPartialJson ||
          !id ||
          seen.has(id) ||
          !isAllowedToolCallName(facts.name, isCompleted(block) ? null : allowedToolNames) ||
          (Boolean(facts.name?.trim()) && facts.name !== facts.name?.trim())
        ) {
          return false;
        }
        seen.add(id);
        return true;
      });
      // Provider-owned thinking content is immutable. Reject an unsafe turn as a unit.
      if (
        replaySafe &&
        toolCalls.every(
          (call) =>
            !preservedThinkingToolCallIds.has(call.id) &&
            (!hasSpawnAttachments || following.ids.has(call.id)) &&
            (!following.displaced || !priorToolCallIds.has(call.id)),
        )
      ) {
        for (const call of toolCalls) {
          preservedThinkingToolCallIds.add(call.id);
          priorToolCallIds.add(call.id);
        }
        changed ||= following.displaced;
        out.push(message);
      } else {
        changed = true;
      }
      continue;
    }

    const nextContent: Block[] = [];
    let messageChanged = false;
    for (const [blockIndex, block] of content.entries()) {
      const facts = blockFacts?.[blockIndex] ?? adapter.block(message, block);
      if (!facts.toolCall) {
        nextContent.push(block);
        continue;
      }
      if (
        !facts.hasInput ||
        !facts.hasIds ||
        !isAllowedToolCallName(facts.name, isCompleted(block) ? null : allowedToolNames) ||
        (facts.hasPartialJson && !facts.finalizedOpenAIResponses)
      ) {
        messageChanged = true;
        continue;
      }
      const name = facts.name?.trim();
      const rename = Boolean(name) && name !== facts.name;
      if (facts.hasPartialJson || rename) {
        nextContent.push(
          adapter.withBlock(block, {
            ...(facts.hasPartialJson ? { removePartialJson: true } : {}),
            ...(rename ? { name } : {}),
          }),
        );
        messageChanged = true;
      } else {
        nextContent.push(block);
      }
    }
    changed ||= messageChanged;
    if (messageChanged && nextContent.length === 0) {
      continue;
    }
    const nextMessage = messageChanged
      ? adapter.withContent(message, nextContent, "inputs")
      : message;
    const pairing = adapter.pairing(nextMessage);
    if (pairing?.role === "assistant") {
      for (const call of pairing.calls) {
        priorToolCallIds.add(call.id);
      }
    }
    out.push(nextMessage);
  }
  return changed ? out : messages;
}

export function sanitizeToolCallInputs(
  messages: AgentMessage[],
  options?: ToolCallInputRepairOptions,
): AgentMessage[] {
  return sanitizeToolCallInputsWithAdapter(messages, agentMessageToolReplayAdapter, options);
}

export function sanitizeToolUseResultPairingWithAdapter<Message, Block>(
  messages: Message[],
  adapter: ToolReplayAdapter<Message, Block>,
  options?: ToolUseResultPairingAdapterOptions<Message>,
): Message[] {
  return repairToolUseResultPairingWithAdapter(messages, adapter, {
    ...options,
    missingToolResultTimestamp: "assistant",
  }).messages;
}

export function sanitizeToolUseResultPairing(
  messages: AgentMessage[],
  options?: ToolUseResultPairingOptions,
): AgentMessage[] {
  return sanitizeToolUseResultPairingWithAdapter(messages, agentMessageToolReplayAdapter, options);
}

export function sanitizeToolUseResultPairingForModel(
  messages: AgentMessage[],
  isOpenAIResponsesApi: boolean,
  pairing?: ReturnType<typeof classifyToolUseResultPairing>,
): AgentMessage[] {
  return sanitizeToolUseResultPairing(messages, {
    pairing,
    erroredAssistantResultPolicy: "drop",
    ...(isOpenAIResponsesApi ? { missingToolResultText: "aborted" } : {}),
  });
}

function repairToolUseResultPairingWithAdapter<Message, Block>(
  messages: Message[],
  adapter: ToolReplayAdapter<Message, Block>,
  options?: ToolUseResultPairingAdapterOptions<Message>,
): { messages: Message[]; added: Message[] } {
  const added: Message[] = [];
  const preserveUnframed = options?.preserveUnframedToolResults === true;
  const normalizeResult = (
    index: number,
    id: string | null,
    normalizeName: boolean,
    name?: string,
  ) => {
    const message = messages[index]!;
    const facts = adapter.pairing(message);
    if (facts?.role !== "toolResult") {
      return message;
    }
    const update: ReplayToolResultUpdate = {};
    if (id && id !== facts.id) {
      update.toolCallId = id;
    }
    if (normalizeName) {
      const toolName =
        normalizeOptionalString(facts.name) ??
        normalizeOptionalString(name) ??
        (typeof facts.name === "string" ? "unknown" : undefined);
      if (toolName && toolName !== facts.name) {
        update.toolName = toolName;
      }
    }
    return Object.keys(update).length ? adapter.withResult(message, update) : message;
  };
  const frames: ReplayToolPairingFrame<Message>[] =
    options?.pairing ??
    classifyToolPairingFacts(
      messages.map((message) => adapter.pairing(message)),
      {
        preserveUnframedToolResults: preserveUnframed,
      },
    ).map((frame) => ({
      startIndex: frame.startIndex,
      endIndex: frame.endIndex,
      failed: frame.failed,
      assistant: messages[frame.startIndex]!,
      occurrences: frame.occurrences.map((occurrence) => ({
        id: occurrence.id,
        name: occurrence.name,
        result: occurrence.result
          ? normalizeResult(occurrence.result.index, occurrence.result.id, true, occurrence.name)
          : undefined,
      })),
      remainder: frame.remainder.map(({ index, id }) =>
        id !== undefined ? normalizeResult(index, id, false) : messages[index]!,
      ),
    }));
  const out: Message[] = [];
  let cursor = 0;
  const pushUnframedRange = (endIndex: number) => {
    for (; cursor < endIndex; cursor += 1) {
      const message = messages[cursor]!;
      if (
        !adapter.valid(message) ||
        (adapter.role(message) === "toolResult" && !preserveUnframed)
      ) {
        continue;
      }
      out.push(message);
    }
  };
  for (const frame of frames) {
    pushUnframedRange(frame.startIndex);
    cursor = frame.endIndex;
    if (!(frame.failed && options?.erroredAssistantResultPolicy === "drop")) {
      out.push(frame.assistant);
      for (const occurrence of frame.occurrences) {
        if (occurrence.result) {
          out.push(occurrence.result);
        } else if (!frame.failed) {
          const missing = adapter.missingResult({
            toolCallId: occurrence.id,
            toolName: occurrence.name,
            text: options?.missingToolResultText,
            timestamp:
              options?.missingToolResultTimestamp === "assistant"
                ? (adapter.timestamp(frame.assistant) ?? 0)
                : undefined,
          });
          added.push(missing);
          out.push(missing);
        }
      }
    }
    out.push(...frame.remainder);
  }
  pushUnframedRange(messages.length);
  const changed =
    out.length !== messages.length || out.some((message, index) => message !== messages[index]);
  return { messages: changed ? out : messages, added };
}

export function repairToolUseResultPairing(
  messages: AgentMessage[],
  options?: ToolUseResultPairingOptions,
): { messages: AgentMessage[]; added: Array<Extract<AgentMessage, { role: "toolResult" }>> } {
  const result = repairToolUseResultPairingWithAdapter(
    messages,
    agentMessageToolReplayAdapter,
    options,
  );
  return { ...result, added: result.added as Array<Extract<AgentMessage, { role: "toolResult" }>> };
}
