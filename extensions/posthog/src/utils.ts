import { randomUUID } from "node:crypto";

export function generateTraceId(): string {
  return randomUUID();
}

export function generateSpanId(): string {
  return randomUUID();
}

export function redactForPrivacy<T>(value: T, privacyMode: boolean): T | null {
  return privacyMode ? null : value;
}

export function safeStringify(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(str: string, maxLen: number): string {
  return str.length <= maxLen ? str : str.slice(0, maxLen) + "…";
}

// -- Message formatting for PostHog LLM Analytics --
//
// OpenClaw uses Anthropic-style content blocks (tool_use, tool_result, text, thinking, etc.)
// PostHog LLM Analytics expects OpenAI chat format:
//   - assistant tool calls: { role: "assistant", content: "...", tool_calls: [{id, type, function}] }
//   - tool results:         { role: "tool", tool_call_id: "...", content: "..." }
//   - regular messages:     { role: "user"|"assistant"|"system", content: "..." }

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type FormattedMessage = {
  role: string;
  content: string | FormattedContentItem[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type FormattedContentItem = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

/**
 * Normalize a content-array item that is NOT a tool_use/tool_result/thinking block.
 * Returns a PostHog-compatible content item or null if it should be skipped.
 */
function normalizeContentItem(obj: Record<string, unknown>): FormattedContentItem | null {
  const type = typeof obj.type === "string" ? obj.type : "";
  if (!type) return null;
  if (type === "text" && typeof obj.text === "string") {
    return { type: "text", text: obj.text };
  }
  if (type === "function") {
    return { type: "function", id: obj.id, function: obj.function };
  }
  if (type === "image" || type === "image_url" || type === "input_image") {
    return obj as FormattedContentItem;
  }
  // Pass through other typed items
  return obj as FormattedContentItem;
}

/**
 * Simplify a content items array: if it's a single text item, return the plain string.
 */
function simplifyContent(items: FormattedContentItem[]): string | FormattedContentItem[] | null {
  if (items.length === 0) return null;
  if (items.length === 1 && items[0]!.type === "text" && typeof items[0]!.text === "string") {
    return items[0]!.text;
  }
  return items;
}

/**
 * Convert a single raw OpenClaw message (or bare string) into one or more
 * OpenAI-style messages that PostHog LLM Analytics can render.
 *
 * A single OpenClaw message can expand into multiple OpenAI messages:
 * - An assistant turn with text + tool_use blocks becomes one message with tool_calls
 * - A user turn with tool_result blocks becomes one "tool" message per result
 */
function normalizeMessage(raw: unknown): FormattedMessage[] {
  // Bare string prompt → user message
  if (typeof raw === "string") {
    return [{ role: "user", content: raw }];
  }
  if (typeof raw !== "object" || raw === null) return [];

  const obj = raw as Record<string, unknown>;
  const role = typeof obj.role === "string" ? obj.role : "user";

  // OpenClaw tool result message → OpenAI role:"tool" message
  if (role === "toolResult") {
    const content =
      typeof obj.content === "string"
        ? obj.content
        : truncate(safeStringify(obj.content) ?? "", 2000);
    return [{ role: "tool", content }];
  }

  // Simple string content — pass through directly
  if (typeof obj.content === "string") {
    return [{ role, content: obj.content }];
  }

  // Non-array content (null, number, etc.)
  if (!Array.isArray(obj.content)) {
    const content = obj.content == null ? "" : String(obj.content);
    return [{ role, content }];
  }

  // Array content — separate into text/media items, tool_use calls, and tool_result blocks
  const contentItems: FormattedContentItem[] = [];
  const toolUseCalls: ToolCall[] = [];
  const toolResults: FormattedMessage[] = [];

  for (const item of obj.content as unknown[]) {
    if (typeof item === "string") {
      contentItems.push({ type: "text", text: item });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const block = item as Record<string, unknown>;
    const type = typeof block.type === "string" ? block.type : "";

    // Skip thinking/reasoning — internal chain-of-thought
    if (type === "thinking" || type === "reasoning") continue;

    // Anthropic tool_use → OpenAI tool_calls
    if (type === "tool_use") {
      toolUseCalls.push({
        id: typeof block.id === "string" ? block.id : `call_${randomUUID()}`,
        type: "function",
        function: {
          name: typeof block.name === "string" ? block.name : "unknown",
          arguments: safeStringify(block.input) ?? "{}",
        },
      });
      continue;
    }

    // OpenClaw toolCall → OpenAI tool_calls (arguments instead of input)
    if (type === "toolCall") {
      toolUseCalls.push({
        id: typeof block.id === "string" ? block.id : `call_${randomUUID()}`,
        type: "function",
        function: {
          name: typeof block.name === "string" ? block.name : "unknown",
          arguments: safeStringify(block.arguments) ?? "{}",
        },
      });
      continue;
    }

    // Anthropic tool_result → OpenAI role:"tool" message
    if (type === "tool_result") {
      const resultContent =
        typeof block.content === "string"
          ? block.content
          : truncate(safeStringify(block.content) ?? "", 2000);
      toolResults.push({
        role: "tool",
        content: resultContent,
        ...(typeof block.tool_use_id === "string" ? { tool_call_id: block.tool_use_id } : {}),
      });
      continue;
    }

    // Regular content item (text, image, etc.)
    const normalized = normalizeContentItem(block);
    if (normalized) contentItems.push(normalized);
  }

  const messages: FormattedMessage[] = [];

  if (toolUseCalls.length > 0) {
    // Assistant message with tool calls (OpenAI format)
    const msg: FormattedMessage = {
      role,
      content: simplifyContent(contentItems),
      tool_calls: toolUseCalls,
    };
    messages.push(msg);
  } else if (toolResults.length > 0) {
    // User turn containing tool results → expand into individual "tool" messages
    // Keep any text content as a separate message
    const textContent = simplifyContent(contentItems);
    if (textContent !== null) {
      messages.push({ role, content: textContent });
    }
    messages.push(...toolResults);
  } else {
    // Regular message (no tool involvement)
    const content = simplifyContent(contentItems);
    if (content !== null) {
      messages.push({ role, content });
    }
  }

  return messages;
}

/**
 * Normalize an array of raw OpenClaw messages into PostHog-compatible
 * OpenAI chat message format (with tool_calls / role:"tool" support).
 */
export function formatInputMessages(rawMessages: unknown[] | null): FormattedMessage[] | null {
  if (!rawMessages) return null;
  const result: FormattedMessage[] = [];
  for (const raw of rawMessages) {
    result.push(...normalizeMessage(raw));
  }
  return result;
}

/**
 * Convert assistant text responses into PostHog-compatible output choices.
 */
export function formatOutputChoices(texts: string[]): FormattedMessage[] {
  return texts.map((text) => ({
    role: "assistant",
    content: text,
  }));
}
