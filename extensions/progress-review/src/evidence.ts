import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const MAX_REQUESTS = 8;
const MAX_UPDATES = 10;
const MAX_TOOL_CALLS = 16;
const REQUEST_CHARS = 2000;
const UPDATE_CHARS = 1200;
const TOOL_INPUT_CHARS = 600;
const TOOL_RESULT_CHARS = 300;

type Excerpt = { text: string; truncated?: true };
type ToolCallEvidence = {
  tool: string;
  input: Excerpt;
  result?: Excerpt & { error?: true };
};

export type ReviewEvidence = {
  requests: Excerpt[];
  updates: Excerpt[];
  toolCalls: ToolCallEvidence[];
};

function excerpt(text: string, limit: number): Excerpt {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text };
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      const record = asOptionalRecord(part);
      return record?.type === "text" ? (normalizeOptionalString(record.text) ?? "") : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function pushBounded<T>(items: T[], item: T, max: number, keepFirst = false) {
  items.push(item);
  if (items.length > max) {
    // The first request usually states the goal; later requests refine it.
    items.splice(keepFirst ? 1 : 0, 1);
  }
}

/**
 * Projects agent messages into bounded reviewer evidence. User requests and tool
 * results are evidence; assistant text is the agent's own claim.
 */
export function buildReviewEvidence(messages: readonly unknown[]): ReviewEvidence {
  const evidence: ReviewEvidence = { requests: [], updates: [], toolCalls: [] };
  const pending = new Map<string, ToolCallEvidence>();
  for (const raw of messages) {
    const message = asOptionalRecord(raw);
    if (!message) {
      continue;
    }
    if (message.role === "user") {
      const text = textOf(message.content);
      if (text) {
        pushBounded(evidence.requests, excerpt(text, REQUEST_CHARS), MAX_REQUESTS, true);
      }
      continue;
    }
    if (message.role === "assistant") {
      const text = textOf(message.content);
      if (text) {
        pushBounded(evidence.updates, excerpt(text, UPDATE_CHARS), MAX_UPDATES);
      }
      for (const part of Array.isArray(message.content) ? message.content : []) {
        const call = asOptionalRecord(part);
        if (call?.type !== "toolCall") {
          continue;
        }
        const entry: ToolCallEvidence = {
          tool: normalizeOptionalString(call.name) ?? "unknown",
          input: excerpt(JSON.stringify(call.arguments ?? {}), TOOL_INPUT_CHARS),
        };
        const id = normalizeOptionalString(call.id);
        if (id) {
          pending.set(id, entry);
        }
        pushBounded(evidence.toolCalls, entry, MAX_TOOL_CALLS);
      }
      continue;
    }
    if (message.role === "toolResult") {
      const id = normalizeOptionalString(message.toolCallId);
      const entry = id ? pending.get(id) : undefined;
      if (id && entry) {
        entry.result = {
          ...excerpt(textOf(message.content), TOOL_RESULT_CHARS),
          ...(message.isError === true ? { error: true as const } : {}),
        };
        pending.delete(id);
      }
    }
  }
  return evidence;
}
