import {
  normalizeOpenAIResponsesFunctionCallId,
  replaceCompactionReplayOwnerContent,
  shouldNormalizeOpenAIResponsesToolCallId,
  splitOpenAIFunctionCallPairing,
} from "@openclaw/ai/transports";
import { parseDateFirstTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { AgentMessage } from "../runtime/index.js";
import { rewriteToolResultIds } from "../tool-call-id.js";

type OpenAIThinkingBlock = {
  type?: unknown;
  thinking?: unknown;
  thinkingSignature?: unknown;
};

type OpenAIToolCallBlock = {
  type?: unknown;
  id?: unknown;
};

function hasOpenAIReasoningSignature(value: unknown): boolean {
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

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type AssistantContentBlock = AssistantMessage["content"][number];

function rewriteAssistantContent(
  message: AssistantMessage,
  rewrite: (block: AssistantContentBlock) => AssistantContentBlock,
): AssistantMessage {
  if (!Array.isArray(message.content)) {
    return message;
  }
  let changed = false;
  const content = message.content.map((block) => {
    const next = rewrite(block);
    changed ||= !Object.is(next, block);
    return next;
  });
  return changed ? replaceCompactionReplayOwnerContent(message, content) : message;
}

/**
 * OpenAI Responses rejects replayed `function_call.call_id`,
 * `function_call.id`, and matching `function_call_output.call_id` values
 * that exceed its 64-char `call_*` / `fc_*` shape. pi-ai skips its own
 * normalizer for same-model replay, then splits persisted `call_id|fc_id`
 * pairs directly into the provider payload, so OpenClaw must normalize here.
 */
export function normalizeOpenAIResponsesToolCallIds(messages: AgentMessage[]): AgentMessage[] {
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
  return rewriteReplayMessages(messages, (msg) => {
    if (!msg || typeof msg !== "object") {
      return msg;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "assistant") {
      const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
      return rewriteAssistantContent(assistantMsg, (block) => {
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
        return {
          ...block,
          id: nextId,
        } as typeof block;
      });
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
 * OpenAI can reject replayed `function_call` items with an `fc_*` id if the
 * matching `reasoning` item is absent in the same assistant turn.
 *
 * When that pairing is missing, strip the `|fc_*` suffix from tool call ids so
 * shared model runtime omits `function_call.id` on replay.
 */
export function downgradeOpenAIFunctionCallReasoningPairs(
  messages: AgentMessage[],
): AgentMessage[] {
  let pendingRewrittenIds: Map<string, string> | null = null;
  return rewriteReplayMessages(messages, (msg) => {
    if (!msg || typeof msg !== "object") {
      pendingRewrittenIds = null;
      return msg;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "assistant") {
      const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
      const localRewrittenIds = new Map<string, string>();
      let seenReplayableReasoning = false;
      const next = rewriteAssistantContent(assistantMsg, (block) => {
        if (!block || typeof block !== "object") {
          return block;
        }

        const thinkingBlock = block as OpenAIThinkingBlock;
        if (
          thinkingBlock.type === "thinking" &&
          hasOpenAIReasoningSignature(thinkingBlock.thinkingSignature)
        ) {
          seenReplayableReasoning = true;
          return block;
        }

        const toolCallBlock = block as OpenAIToolCallBlock;
        if (!isOpenAIToolCallType(toolCallBlock.type) || typeof toolCallBlock.id !== "string") {
          return block;
        }

        const pairing = splitOpenAIFunctionCallPairing(toolCallBlock.id);
        if (seenReplayableReasoning || !pairing.itemId || !pairing.itemId.startsWith("fc_")) {
          return block;
        }

        localRewrittenIds.set(toolCallBlock.id, pairing.callId);
        return {
          ...block,
          id: pairing.callId,
        } as typeof block;
      });
      pendingRewrittenIds = localRewrittenIds.size > 0 ? localRewrittenIds : null;
      return next;
    }

    if (role === "toolResult" && pendingRewrittenIds && pendingRewrittenIds.size > 0) {
      const toolResult = msg as Extract<AgentMessage, { role: "toolResult" }> & {
        toolUseId?: unknown;
      };
      const updates: Record<string, string> = {};
      for (const field of ["toolCallId", "toolUseId"] as const) {
        const id = toolResult[field];
        const nextId = typeof id === "string" ? pendingRewrittenIds.get(id) : undefined;
        if (nextId && nextId !== id) {
          updates[field] = nextId;
        }
      }
      return Object.keys(updates).length > 0 ? { ...toolResult, ...updates } : msg;
    }

    pendingRewrittenIds = null;
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
export function dropStaleOpenAIReasoning(
  messages: AgentMessage[],
  dropBefore?: number,
): AgentMessage[] {
  if (dropBefore === undefined) {
    return messages;
  }
  return rewriteReplayMessages(messages, (msg) => {
    if (!msg || typeof msg !== "object") {
      return msg;
    }

    const role = (msg as { role?: unknown }).role;
    if (role !== "assistant") {
      return msg;
    }

    const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
    if (!Array.isArray(assistantMsg.content)) {
      return msg;
    }
    const messageTimestamp = parseDateFirstTimestampMs(assistantMsg.timestamp);
    // Timestamp-less legacy entries cannot prove they belong to the new route;
    // treat them as pre-switch so stale provider ids never re-enter replay.
    if (messageTimestamp !== undefined && messageTimestamp > dropBefore) {
      return msg;
    }

    let changed = false;
    let droppedReplayableReasoning = false;
    const nextContent: AssistantContentBlock[] = [];
    for (const block of assistantMsg.content) {
      if (!block) {
        changed = true;
        continue;
      }
      const record = block as OpenAIThinkingBlock;
      if (
        typeof block !== "object" ||
        record.type !== "thinking" ||
        !hasOpenAIReasoningSignature(record.thinkingSignature)
      ) {
        nextContent.push(block);
        continue;
      }
      changed = true;
      droppedReplayableReasoning = true;
    }

    if (!changed) {
      return msg;
    }

    if (nextContent.length === 0) {
      return DROP_REPLAY_MESSAGE;
    }

    // When a replayable reasoning (rs_*) item is dropped after a model/fallback
    // switch, its paired assistant message id (msg_*) must be dropped too. The
    // Responses transport replays msg_* from a text block textSignature, so an
    // orphaned msg_* without its rs_* makes providers like Azure reject the next
    // turn (issue #88019). Drop the id from the signature, but keep any phase
    // metadata (commentary/final_answer) so the Responses phase contract survives.
    const finalContent = droppedReplayableReasoning
      ? nextContent.map((contentBlock) => {
          if (!contentBlock || typeof contentBlock !== "object") {
            return contentBlock;
          }
          if (contentBlock.type !== "text" || contentBlock.textSignature === undefined) {
            return contentBlock;
          }
          const phase = extractTextSignaturePhase(contentBlock.textSignature);
          const { textSignature: _droppedTextSignature, ...rest } = contentBlock;
          return phase !== undefined
            ? { ...rest, textSignature: JSON.stringify({ v: 1, phase }) }
            : rest;
        })
      : nextContent;

    return replaceCompactionReplayOwnerContent(assistantMsg, finalContent);
  });
}
