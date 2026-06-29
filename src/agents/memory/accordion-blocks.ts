import type { TextContent } from "../../llm/types.js";
/**
 * Accordion block identity + kind-safe in-place folding (Phase 2, 02-02 foundation).
 *
 * Adapted from a-Fig/Accordion (https://github.com/a-Fig/Accordion,
 * `app/src/lib/live/mapping.ts`), MIT License, Copyright (c) 2026 Accordion
 * contributors. OpenClaw is built on the same pi/llm-core message model, so the
 * durable content-anchored block-id scheme transfers directly and resolves the
 * 02-02 R1 correlation risk:
 * instead of fragile positional/content-hash matching, every foldable message part
 * gets a stable id keyed off its `timestamp` / `responseId` / `toolCallId`.
 *
 * Folding is **in place**: we never drop a message, so tool_call/tool_result pairs
 * can never be orphaned. Token reclamation comes from replacing big bodies (assistant
 * text/thinking, tool-result content) with a short digest while preserving every
 * structural field the provider expects (role, toolCallId, toolName, isError).
 */
import type { AgentMessage } from "../runtime/index.js";

/** A digest plan: durable block id → the short text that replaces the folded body. */
export type FoldPlan = ReadonlyMap<string, string>;

function digestPart(text: string): TextContent {
  return { type: "text", text };
}

/**
 * Durable, content-anchored block id — IDENTICAL regardless of array position.
 * `partIndex` applies to assistant content parts (each part is independently foldable);
 * omit it for user / tool-result / other roles. Falls back to a positional `m<i>:…`
 * id only when the durable anchor is missing; positional ids are never folded.
 */
export function blockId(message: AgentMessage, index: number, partIndex?: number): string {
  const m = message as {
    role?: string;
    timestamp?: number;
    responseId?: string;
    toolCallId?: string;
  };
  switch (m.role) {
    case "user":
      return m.timestamp != null ? `u:${m.timestamp}` : `m${index}:u`;
    case "assistant": {
      if (partIndex == null) return `m${index}:p?`;
      const anchor =
        m.responseId != null ? m.responseId : m.timestamp != null ? `t${m.timestamp}` : null;
      return anchor != null ? `a:${anchor}:p${partIndex}` : `m${index}:p${partIndex}`;
    }
    case "toolResult":
      return m.toolCallId != null ? `r:${m.toolCallId}` : `m${index}:r`;
    default:
      return m.timestamp != null ? `s:${m.timestamp}` : `m${index}:s`;
  }
}

/**
 * Per-MESSAGE durable anchor (no part index) — `u:<ts>` / `a:<responseId|t+ts>` /
 * `r:<toolCallId>` / `s:<ts>`. This is the single source of truth for the anchor
 * formula shared by capture (turn idempotency key) and the accordion (mapping a live
 * message back to its captured turn / box). A `null` anchor means the message has no
 * durable identity (skip it: never captured, never folded).
 */
export function messageAnchorId(message: AgentMessage): string | null {
  const m = message as {
    role?: string;
    timestamp?: number;
    responseId?: string;
    toolCallId?: string;
  };
  switch (m.role) {
    case "user":
      return m.timestamp != null ? `u:${m.timestamp}` : null;
    case "assistant": {
      const anchor =
        m.responseId != null ? m.responseId : m.timestamp != null ? `t${m.timestamp}` : null;
      return anchor != null ? `a:${anchor}` : null;
    }
    case "toolResult":
      return m.toolCallId != null ? `r:${m.toolCallId}` : null;
    default:
      return m.timestamp != null ? `s:${m.timestamp}` : null;
  }
}

/** True for ids keyed off a durable anchor (foldable); false for positional fallbacks. */
export function isDurableId(id: string): boolean {
  return id.startsWith("u:") || id.startsWith("a:") || id.startsWith("r:") || id.startsWith("s:");
}

/**
 * Apply a fold plan in place. Returns a new array (same length, same order) where
 * folded blocks have their body replaced by the digest. Kind-safety rules:
 *  - assistant `text`/`thinking` part → digest replaces the body
 *  - assistant `toolCall` part → NEVER folded (would orphan its result)
 *  - tool-result → keep `toolCallId`/`toolName`/`isError`, replace `content` with the digest
 *  - user / other → digest replaces the text body
 *  - non-durable ids are never folded (defensive: the plan should only carry durable ids)
 */
export function applyFold(messages: readonly AgentMessage[], plan: FoldPlan): AgentMessage[] {
  if (plan.size === 0) {
    return messages.slice();
  }
  return messages.map((message, index) => {
    const m = message as {
      role?: string;
      content?: unknown;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
    };

    if (m.role === "assistant" && Array.isArray(m.content)) {
      let changed = false;
      const parts = m.content.map((part, partIndex) => {
        const p = part as { type?: string };
        // tool_call parts are structural — folding one orphans its tool_result.
        if (p.type === "toolCall") {
          return part;
        }
        const id = blockId(message, index, partIndex);
        const digest = isDurableId(id) ? plan.get(id) : undefined;
        if (digest == null) {
          return part;
        }
        changed = true;
        if (p.type === "thinking") {
          return { ...(part as object), thinking: digest } as typeof part;
        }
        return { ...(part as object), type: "text", text: digest } as typeof part;
      });
      return changed ? ({ ...(message as object), content: parts } as AgentMessage) : message;
    }

    const id = blockId(message, index);
    const digest = isDurableId(id) ? plan.get(id) : undefined;
    if (digest == null) {
      return message;
    }

    if (m.role === "toolResult") {
      // Keep the envelope (toolCallId/toolName/isError) so the pair stays intact;
      // only the (possibly huge) result body is replaced. This is the cheap win:
      // the model still sees the same tool call answered, minus the token bulk.
      return { ...(message as object), content: [digestPart(digest)] } as AgentMessage;
    }

    // user / other: replace the text body with the digest.
    return { ...(message as object), content: [digestPart(digest)] } as AgentMessage;
  });
}
