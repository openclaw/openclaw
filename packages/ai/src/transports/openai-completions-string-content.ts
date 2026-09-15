/**
 * OpenAI Chat Completions compatibility helpers. Some providers only accept
 * role/content messages with plain string content instead of text block arrays.
 * Models that declare `compat.supportsTools: false` also cannot replay
 * `tool_calls` or `role: "tool"` turns — those backends reject the request.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";

function readMessageRole(message: Record<string, unknown>): string | undefined {
  return typeof message.role === "string" ? message.role : undefined;
}

function readPlainMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const textParts: string[] = [];
  for (const item of content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
      continue;
    }
    textParts.push(item.text);
  }
  return textParts.join("\n");
}

function summarizeCompletionToolCalls(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return "";
  }
  const names = toolCalls.flatMap((call) => {
    if (!isRecord(call) || !isRecord(call.function)) {
      return [];
    }
    return typeof call.function.name === "string" && call.function.name.length > 0
      ? [call.function.name]
      : [];
  });
  return names.length > 0 ? `[tool call: ${names.join(", ")}]` : "[tool call]";
}

function appendAssistantPlainText(message: Record<string, unknown>, extra: string): void {
  const current = readPlainMessageText(message.content);
  const next = [current, extra].filter((part) => part.trim().length > 0).join("\n");
  message.content = next.length > 0 ? next : extra;
}

function flattenStringOnlyCompletionContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  const textParts: string[] = [];
  for (const item of content) {
    if (
      !item ||
      typeof item !== "object" ||
      (item as { type?: unknown }).type !== "text" ||
      typeof (item as { text?: unknown }).text !== "string"
    ) {
      return content;
    }
    textParts.push((item as { text: string }).text);
  }
  return textParts.join("\n");
}

/** Flatten string-only text block content arrays into newline-joined strings. */
export function flattenCompletionMessagesToStringContent(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object") {
      return message;
    }
    const content = (message as { content?: unknown }).content;
    const flattenedContent = flattenStringOnlyCompletionContent(content);
    if (flattenedContent === content) {
      return message;
    }
    return {
      ...message,
      content: flattenedContent,
    };
  });
}

/** Strip completion messages to role/content fields for strict providers. */
export function stripCompletionMessagesToRoleContent(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return message;
    }
    const record = message as Record<string, unknown>;
    const stripped: Record<string, unknown> = {};
    if (Object.hasOwn(record, "role")) {
      stripped.role = record.role;
    }
    if (Object.hasOwn(record, "content")) {
      stripped.content = record.content;
    }
    return stripped;
  });
}

/**
 * Replay tool protocol as plain assistant text. Chat Completions backends that
 * do not accept tools still 400 if prior `tool_calls` or tool-result roles
 * remain after the `tools` array is omitted.
 */
export function flattenUnsupportedCompletionsToolHistory(messages: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (!isRecord(message)) {
      out.push(message);
      continue;
    }
    const role = readMessageRole(message);
    if (role === "tool" || role === "function") {
      const result = readPlainMessageText(message.content);
      const note = result.trim().length > 0 ? `[tool result]\n${result}` : "[tool result]";
      const last = out.at(-1);
      if (isRecord(last) && readMessageRole(last) === "assistant") {
        appendAssistantPlainText(last, note);
      } else {
        out.push({ role: "assistant", content: note });
      }
      continue;
    }
    if (role === "assistant") {
      const next: Record<string, unknown> = { ...message };
      const hadToolPayload =
        Object.hasOwn(next, "tool_calls") || Object.hasOwn(next, "function_call");
      const toolNote = summarizeCompletionToolCalls(next.tool_calls);
      delete next.tool_calls;
      delete next.function_call;
      if (toolNote) {
        appendAssistantPlainText(next, toolNote);
      } else if (hadToolPayload && readPlainMessageText(next.content).length === 0) {
        next.content = "[tool call]";
      }
      out.push(next);
      continue;
    }
    out.push(message);
  }
  return out;
}
