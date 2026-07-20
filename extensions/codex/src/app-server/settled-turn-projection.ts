import { Buffer } from "node:buffer";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { JsonValue } from "./protocol.js";

const MAX_RESPONSE_ITEMS = 200;
const MAX_PROJECTION_BYTES = 512 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const TRUNCATION_SUFFIX = "\n\n[Content truncated during settled-turn finalization.]";
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/u;

type ProjectedMessageGroup = {
  items: JsonValue[];
  callIds: string[];
  resultIds: string[];
  bytes: number;
  containsToolResult: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function truncateUtf8(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES) {
    return value;
  }
  const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
  const source = Buffer.from(value);
  let end = Math.max(0, MAX_TEXT_BYTES - suffixBytes);
  while (end > 0 && source[end] !== undefined && (source[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return `${source.subarray(0, end).toString("utf8")}${TRUNCATION_SUFFIX}`;
}

function responseItemBytes(item: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(item), "utf8");
}

function requireCallId(value: unknown): string {
  const callId = readNonEmptyString(value);
  if (!callId || callId.length > 256) {
    throw new Error("Codex settled-turn projection found an invalid tool call id");
  }
  return callId;
}

function requireToolName(value: unknown): string {
  const name = readNonEmptyString(value);
  if (!name || !TOOL_NAME_PATTERN.test(name)) {
    throw new Error("Codex settled-turn projection found an invalid tool name");
  }
  return name;
}

function serializeToolArguments(value: unknown): string {
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("Codex settled-turn projection found invalid JSON tool arguments");
    }
    if (!isRecord(parsed)) {
      throw new Error("Codex settled-turn projection requires object tool arguments");
    }
    return value;
  }
  if (!isRecord(value)) {
    throw new Error("Codex settled-turn projection requires object tool arguments");
  }
  return JSON.stringify(value);
}

function projectUserMessage(message: Record<string, unknown>): JsonValue[] {
  if (typeof message.content === "string") {
    const text = truncateUtf8(message.content.trim());
    if (!text) {
      throw new Error("Codex settled-turn projection found an empty user message");
    }
    return [{ type: "message", role: "user", content: [{ type: "input_text", text }] }];
  }
  if (!Array.isArray(message.content)) {
    throw new Error("Codex settled-turn projection found unsupported user content");
  }
  const content: JsonValue[] = [];
  for (const value of message.content) {
    if (!isRecord(value)) {
      throw new Error("Codex settled-turn projection found malformed user content");
    }
    if (value.type === "text") {
      const text = truncateUtf8(readNonEmptyString(value.text) ?? "");
      if (text) {
        content.push({ type: "input_text", text });
      }
      continue;
    }
    if (value.type === "image") {
      const data = readNonEmptyString(value.data);
      const mimeType = readNonEmptyString(value.mimeType) ?? "image/png";
      if (!data || data.startsWith("http://") || data.startsWith("https://")) {
        throw new Error("Codex settled-turn projection requires inline user images");
      }
      content.push({
        type: "input_image",
        image_url: data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`,
      });
      continue;
    }
    throw new Error(
      `Codex settled-turn projection does not support user content ${String(value.type)}`,
    );
  }
  if (content.length === 0) {
    throw new Error("Codex settled-turn projection found an empty user message");
  }
  return [{ type: "message", role: "user", content }];
}

function projectAssistantMessage(message: Record<string, unknown>): {
  items: JsonValue[];
  callIds: string[];
} {
  const values =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  if (!Array.isArray(values)) {
    throw new Error("Codex settled-turn projection found unsupported assistant content");
  }
  const items: JsonValue[] = [];
  const callIds: string[] = [];
  for (const value of values) {
    if (!isRecord(value)) {
      throw new Error("Codex settled-turn projection found malformed assistant content");
    }
    if (value.type === "text") {
      const text = truncateUtf8(readNonEmptyString(value.text) ?? "");
      if (text) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      continue;
    }
    if (value.type === "toolCall") {
      const callId = requireCallId(value.id ?? value.toolCallId);
      const name = requireToolName(value.name ?? value.toolName);
      callIds.push(callId);
      items.push({
        type: "function_call",
        call_id: callId,
        name,
        arguments: serializeToolArguments(value.arguments ?? value.input),
      });
      continue;
    }
    if (value.type === "thinking" || value.type === "reasoning") {
      continue;
    }
    throw new Error(
      `Codex settled-turn projection does not support assistant content ${String(value.type)}`,
    );
  }
  return { items, callIds };
}

function projectToolResult(message: Record<string, unknown>): {
  item: JsonValue;
  resultId: string;
} {
  const resultId = requireCallId(message.toolCallId);
  if (!Array.isArray(message.content)) {
    throw new Error("Codex settled-turn projection found unsupported tool result content");
  }
  const parts: string[] = [];
  for (const value of message.content) {
    if (!isRecord(value)) {
      throw new Error("Codex settled-turn projection found malformed tool result content");
    }
    if (value.type === "image") {
      const mimeType = readNonEmptyString(value.mimeType) ?? "unknown type";
      // The finalizer selects models by text capability. Preserve valid image
      // evidence as bounded metadata instead of requiring vision or embedding
      // large base64 payloads in the disposable child.
      parts.push(`[Image tool result: ${mimeType}]`);
      continue;
    }
    if (value.type !== "text" && value.type !== "toolResult") {
      throw new Error("Codex settled-turn projection found malformed tool result content");
    }
    const text =
      value.type === "text"
        ? readNonEmptyString(value.text)
        : (readNonEmptyString(value.content) ?? readNonEmptyString(value.text));
    if (text) {
      parts.push(text);
    }
  }
  const output = truncateUtf8(parts.join("\n") || "Tool completed without textual output.");
  return {
    resultId,
    item: { type: "function_call_output", call_id: resultId, output },
  };
}

function projectMessage(message: AgentMessage): ProjectedMessageGroup | undefined {
  const record = message as unknown as Record<string, unknown>;
  let items: JsonValue[];
  let callIds: string[] = [];
  let resultIds: string[] = [];
  if (message.role === "user") {
    items = projectUserMessage(record);
  } else if (message.role === "assistant") {
    const projected = projectAssistantMessage(record);
    items = projected.items;
    callIds = projected.callIds;
  } else if (message.role === "toolResult") {
    const projected = projectToolResult(record);
    items = [projected.item];
    resultIds = [projected.resultId];
  } else {
    throw new Error(`Codex settled-turn projection does not support role ${message.role}`);
  }
  if (items.length === 0) {
    return undefined;
  }
  return {
    items,
    callIds,
    resultIds,
    bytes: items.reduce<number>((total, item) => total + responseItemBytes(item), 0),
    containsToolResult: resultIds.length > 0,
  };
}

function hasExactlyPairedCalls(groups: readonly ProjectedMessageGroup[]): boolean {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const group of groups) {
    for (const id of group.callIds) {
      if (calls.has(id)) {
        return false;
      }
      calls.add(id);
    }
    for (const id of group.resultIds) {
      if (results.has(id)) {
        return false;
      }
      results.add(id);
    }
  }
  return calls.size === results.size && [...calls].every((id) => results.has(id));
}

/** Projects a bounded transcript tail while keeping every tool call/result pair atomic. */
export function projectSettledCodexMessages(messages: readonly AgentMessage[]): JsonValue[] {
  const groups = messages.flatMap((message) => {
    const projected = projectMessage(message);
    return projected ? [projected] : [];
  });
  const lastToolResultIndex = groups.findLastIndex((group) => group.containsToolResult);
  if (lastToolResultIndex < 0) {
    throw new Error("Codex settled-turn projection found no completed tool result");
  }
  if (!hasExactlyPairedCalls(groups)) {
    throw new Error("Codex settled-turn projection found an ambiguous tool transcript");
  }

  let selectedStart = -1;
  let itemCount = 0;
  let byteCount = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    itemCount += group.items.length;
    byteCount += group.bytes;
    if (itemCount > MAX_RESPONSE_ITEMS || byteCount > MAX_PROJECTION_BYTES) {
      break;
    }
    const candidate = groups.slice(index);
    if (index <= lastToolResultIndex && hasExactlyPairedCalls(candidate)) {
      selectedStart = index;
    }
  }
  if (selectedStart < 0) {
    throw new Error("Codex settled-turn projection cannot fit an atomic tool transcript");
  }
  return groups.slice(selectedStart).flatMap((group) => group.items);
}
