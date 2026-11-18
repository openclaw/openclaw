import {
  normalizeOpenAIResponsesFunctionCallId,
  replaceCompactionReplayOwnerContent,
  shouldNormalizeOpenAIResponsesToolCallId,
} from "@openclaw/ai/transports";
import { parseDateFirstTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { AgentMessage } from "../runtime/index.js";
import { rewriteToolResultIds } from "../tool-call-id.js";

type OpenAIToolCallBlock = {
  type?: unknown;
  id?: unknown;
};

export function hasOpenAIReasoningSignature(value: unknown): boolean {
  if (!value) {
    return false;
  }
  let candidate: { id?: unknown; type?: unknown } | null = null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return false;
    }
    try {
      candidate = JSON.parse(trimmed) as { id?: unknown; type?: unknown };
    } catch {
      return false;
    }
  } else if (typeof value === "object") {
    candidate = value as { id?: unknown; type?: unknown };
  }
  if (!candidate) {
    return false;
  }
  const id = typeof candidate.id === "string" ? candidate.id : "";
  const type = typeof candidate.type === "string" ? candidate.type : "";
  return id.startsWith("rs_") && (type === "reasoning" || type.startsWith("reasoning."));
}

function isOpenAIToolCallType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

const DROP_REPLAY_MESSAGE = Symbol("dropReplayMessage");

function rewriteReplayMessages(
  messages: AgentMessage[],
  rewrite: (message: AgentMessage) => AgentMessage | typeof DROP_REPLAY_MESSAGE,
): AgentMessage[] {
  let changed = false;
  const result: AgentMessage[] = [];
  for (const message of messages) {
    const next = rewrite(message);
    changed ||= !Object.is(next, message);
    if (next !== DROP_REPLAY_MESSAGE) {
      result.push(next);
    }
  }
  return changed ? result : messages;
}

/**
 * OpenAI Responses rejects replayed `function_call.call_id`,
 * `function_call.id`, and matching `function_call_output.call_id` values
 * that exceed its 64-char `call_*` / `fc_*` shape. pi-ai skips its own
 * normalizer for same-model replay, then splits persisted `call_id|fc_id`
 * pairs directly into the provider payload, so OpenClaw must normalize here.
 */
export function createOpenAIResponsesReplayIdResolver(): (id: string) => string {
  const rewrittenByOriginalId = new Map<string, string>();
  const resolveId = (id: string): string => {
    const rewritten = rewrittenByOriginalId.get(id);
    if (rewritten) {
      return rewritten;
    }
    if (!shouldNormalizeOpenAIResponsesToolCallId(id)) {
      return id;
    }
    const normalized = normalizeOpenAIResponsesFunctionCallId(id);
    rewrittenByOriginalId.set(id, normalized);
    return normalized;
  };
  return resolveId;
}

export function normalizeOpenAIResponsesToolCallIds(messages: AgentMessage[]): AgentMessage[] {
  const resolveId = createOpenAIResponsesReplayIdResolver();
  return rewriteReplayMessages(messages, (msg) => {
    if (!msg || typeof msg !== "object") {
      return msg;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "assistant") {
      const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
      if (!Array.isArray(assistantMsg.content)) {
        return assistantMsg;
      }
      let changed = false;
      const content = assistantMsg.content.map((block) => {
        if (!block || typeof block !== "object") {
          return block;
        }
        const toolCallBlock = block as OpenAIToolCallBlock;
        if (!isOpenAIToolCallType(toolCallBlock.type) || typeof toolCallBlock.id !== "string") {
          return block;
        }

        const nextId = resolveId(toolCallBlock.id);
        if (nextId === toolCallBlock.id) {
          return block;
        }
        changed = true;
        return {
          ...block,
          id: nextId,
        } as typeof block;
      });
      return changed ? replaceCompactionReplayOwnerContent(assistantMsg, content) : assistantMsg;
    }

    if (role === "toolResult") {
      return rewriteToolResultIds({
        message: msg as Extract<AgentMessage, { role: "toolResult" }>,
        resolveId,
      });
    }
    return msg;
  });
}

/**
 * Used when dropping the paired msg_* id so phase metadata can be preserved independently.
 */
function extractTextSignaturePhase(signature: string): "commentary" | "final_answer" | undefined {
  if (!signature.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(signature) as { v?: unknown; phase?: unknown };
    if (parsed.v === 1 && (parsed.phase === "commentary" || parsed.phase === "final_answer")) {
      return parsed.phase;
    }
  } catch {
    // Not a structured signature; nothing to preserve.
  }
  return undefined;
}

/**
 * Drops reasoning from before a model route switch and clears paired message ids.
 * The transport owns orphan detection after preparing the actual replay payload.
 */
export function dropStaleOpenAIReasoningWithAdapter<T, B>(
  messages: T[],
  dropBefore: number | undefined,
  adapter: {
    role(message: T): string | undefined;
    timestamp(message: T): number | undefined;
    content(message: T): readonly B[];
    keep(block: B): boolean;
    reasoning(block: B): boolean;
    clearPairedSignature(block: B): B;
    replace(message: T, content: B[]): T;
  },
): T[] {
  if (dropBefore === undefined) {
    return messages;
  }
  let changed = false;
  const result: T[] = [];
  for (const message of messages) {
    if (adapter.role(message) !== "assistant") {
      result.push(message);
      continue;
    }
    const timestamp = adapter.timestamp(message);
    if (timestamp !== undefined && timestamp > dropBefore) {
      result.push(message);
      continue;
    }
    const original = adapter.content(message);
    let droppedReasoning = false;
    const content = original.filter((block) => {
      if (!adapter.keep(block)) {
        return false;
      }
      if (adapter.reasoning(block)) {
        droppedReasoning = true;
        return false;
      }
      return true;
    });
    if (content.length === original.length) {
      result.push(message);
      continue;
    }
    changed = true;
    if (content.length > 0) {
      result.push(
        adapter.replace(
          message,
          droppedReasoning ? content.map((block) => adapter.clearPairedSignature(block)) : content,
        ),
      );
    }
  }
  return changed ? result : messages;
}

export function dropStaleOpenAIReasoning(
  messages: AgentMessage[],
  dropBefore?: number,
): AgentMessage[] {
  return dropStaleOpenAIReasoningWithAdapter<
    AgentMessage,
    Extract<AgentMessage, { role: "assistant" }>["content"][number]
  >(messages, dropBefore, {
    role: (message) => message?.role,
    timestamp: (message) => parseDateFirstTimestampMs(message.timestamp),
    content: (message) => (message.role === "assistant" ? message.content : []),
    keep: (block) => Boolean(block),
    reasoning: (block) =>
      typeof block === "object" &&
      block.type === "thinking" &&
      hasOpenAIReasoningSignature(block.thinkingSignature),
    clearPairedSignature: (block) => {
      if (
        !block ||
        typeof block !== "object" ||
        block.type !== "text" ||
        block.textSignature === undefined
      ) {
        return block;
      }
      const phase = extractTextSignaturePhase(block.textSignature);
      const { textSignature: _removed, ...rest } = block;
      return phase !== undefined
        ? { ...rest, textSignature: JSON.stringify({ v: 1, phase }) }
        : rest;
    },
    replace: (message, content) =>
      message.role === "assistant"
        ? replaceCompactionReplayOwnerContent(message, content)
        : message,
  });
}
