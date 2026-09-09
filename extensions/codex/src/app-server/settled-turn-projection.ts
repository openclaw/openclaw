import { Buffer } from "node:buffer";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CodexHistoryRejection } from "./history-rejection.js";
import type { JsonValue } from "./protocol.js";
import { readUpstreamUserText } from "./upstream-prompt-provenance.js";

const MAX_RESPONSE_ITEMS = 200;
const MAX_PROJECTION_BYTES = 512 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
// Projected names replay as function_call history items, which Codex
// thread/inject_items deserializes as free-form strings (ResponseItem::FunctionCall).
// Codex records MCP and connector calls under dotted namespaced ids
// ("codex_apps.slack.slack_send"), so "." must stay projectable or any turn
// that used such a tool can never finalize.
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/u;
const TOOL_ERROR_STATUS_PREFIX = "[Tool result status: error]\n";

function readBoundedText(
  value: unknown,
  projection: HistoryProjection,
  maxBytes = MAX_TEXT_BYTES,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    projection.exceedLimit("field_limit");
  }
  return value;
}

function requireBoundedText(
  value: unknown,
  projection: HistoryProjection,
  maxBytes = MAX_TEXT_BYTES,
): string {
  const text = readBoundedText(value, projection, maxBytes);
  if (!text) {
    throw new CodexHistoryRejection("invalid_content");
  }
  return text;
}

function responseItemBytes(item: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(item), "utf8");
}

function requireCallId(value: unknown): string {
  const callId = normalizeOptionalString(value);
  if (!callId || callId.length > 256) {
    throw new CodexHistoryRejection("invalid_content");
  }
  return callId;
}

function requireToolName(value: unknown): string {
  const name = normalizeOptionalString(value);
  if (!name || !TOOL_NAME_PATTERN.test(name)) {
    throw new CodexHistoryRejection("invalid_content");
  }
  return name;
}

function serializeToolArguments(value: unknown, projection: HistoryProjection): string {
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new CodexHistoryRejection("invalid_content");
    }
    if (!isRecord(parsed)) {
      throw new CodexHistoryRejection("invalid_content");
    }
    return requireBoundedText(value, projection);
  }
  if (!isRecord(value)) {
    throw new CodexHistoryRejection("invalid_content");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new CodexHistoryRejection("invalid_content");
  }
  return requireBoundedText(serialized, projection);
}

function projectUserMessage(
  message: Extract<AgentMessage, { role: "user" }>,
  projection: HistoryProjection,
): void {
  const upstreamUserText = readUpstreamUserText(message);
  if (typeof message.content === "string") {
    const text = upstreamUserText
      ? requireBoundedText(upstreamUserText, projection, MAX_PROJECTION_BYTES)
      : requireBoundedText(message.content, projection);
    if (!projection.omitted) {
      projection.appendItem({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      });
    }
    return;
  }
  if (!Array.isArray(message.content)) {
    throw new CodexHistoryRejection("unsupported_content");
  }
  const content: JsonValue[] = [];
  let hasText = false;
  let bytes = responseItemBytes({ type: "message", role: "user", content });
  for (const value of message.content) {
    if (!isRecord(value)) {
      throw new CodexHistoryRejection("invalid_content");
    }
    if (value.type !== "text") {
      throw new CodexHistoryRejection(
        value.type === "image" ? "unsupported_user_image" : "unsupported_content",
      );
    }
    const text = readBoundedText(value.text, projection);
    if (text) {
      hasText = true;
      if (projection.omitted) {
        content.length = 0;
        continue;
      }
      const part = { type: "input_text", text };
      bytes += responseItemBytes(part) + (content.length > 0 ? 1 : 0);
      if (bytes > MAX_PROJECTION_BYTES) {
        projection.exceedLimit("byte_limit");
      }
      if (projection.omitted) {
        content.length = 0;
      } else {
        content.push(part);
      }
    }
  }
  if (!hasText) {
    throw new CodexHistoryRejection("invalid_content");
  }
  if (!projection.omitted) {
    projection.appendItem({ type: "message", role: "user", content });
  }
}

function projectAssistantMessage(
  message: Extract<AgentMessage, { role: "assistant" }>,
  projection: HistoryProjection,
): void {
  const values: unknown =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  if (!Array.isArray(values)) {
    throw new CodexHistoryRejection("unsupported_content");
  }
  for (const value of values) {
    if (!isRecord(value)) {
      throw new CodexHistoryRejection("invalid_content");
    }
    if (value.type === "text") {
      const text = readBoundedText(value.text, projection);
      if (text && !projection.omitted) {
        projection.appendItem({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      continue;
    }
    if (value.type === "toolCall") {
      const id = requireCallId(value.id ?? value.toolCallId);
      const name = requireToolName(value.name ?? value.toolName);
      const args = serializeToolArguments(value.arguments ?? value.input, projection);
      projection.recordCall(id, name);
      if (!projection.omitted) {
        projection.appendItem({
          type: "function_call",
          call_id: id,
          name,
          arguments: args,
        });
      }
      continue;
    }
    if (value.type === "thinking" || value.type === "reasoning") {
      // Private/non-visible reasoning is deliberately outside the application transcript.
      continue;
    }
    throw new CodexHistoryRejection("unsupported_content");
  }
}

function projectToolResult(
  message: Extract<AgentMessage, { role: "toolResult" }>,
  projection: HistoryProjection,
): void {
  const id = requireCallId(message.toolCallId);
  const name = requireToolName(message.toolName);
  if (!Array.isArray(message.content)) {
    throw new CodexHistoryRejection("unsupported_content");
  }
  const isErrorValue: unknown = message.isError;
  if (isErrorValue !== undefined && typeof isErrorValue !== "boolean") {
    throw new CodexHistoryRejection("invalid_content");
  }
  const isError = isErrorValue === true;
  const parts: string[] = [];
  let bytes = 0;
  const appendText = (text: string) => {
    if (projection.omitted) {
      parts.length = 0;
      return;
    }
    bytes += Buffer.byteLength(text, "utf8") + (parts.length > 0 ? 1 : 0);
    if (bytes > MAX_TEXT_BYTES) {
      projection.exceedLimit("field_limit");
    }
    if (projection.omitted) {
      parts.length = 0;
    } else {
      parts.push(text);
    }
  };
  for (const value of message.content) {
    if (!isRecord(value)) {
      throw new CodexHistoryRejection("invalid_content");
    }
    if (value.type === "image") {
      const mimeType = normalizeOptionalString(value.mimeType) ?? "unknown type";
      // The finalizer selects by text capability. Preserve image evidence as
      // metadata without embedding an executable or oversized multimodal payload.
      appendText(`[Image tool result: ${mimeType}]`);
      continue;
    }
    if (value.type !== "text" && value.type !== "toolResult") {
      throw new CodexHistoryRejection("invalid_content");
    }
    const text =
      value.type === "text"
        ? readBoundedText(value.text, projection)
        : readBoundedText(value.content ?? value.text, projection);
    if (text) {
      appendText(text);
    }
  }
  if (projection.omitted) {
    projection.recordResult(id, name);
    return;
  }
  const resultText =
    parts.join("\n") ||
    (isError ? "Tool failed without textual output." : "Tool completed without textual output.");
  // Codex function-call output has no status field. Preserve failure truth in
  // the text boundary so the final answer cannot reinterpret errors as success.
  const output = requireBoundedText(
    isError ? `${TOOL_ERROR_STATUS_PREFIX}${resultText}` : resultText,
    projection,
    isError ? MAX_TEXT_BYTES + Buffer.byteLength(TOOL_ERROR_STATUS_PREFIX, "utf8") : MAX_TEXT_BYTES,
  );
  projection.recordResult(id, name);
  projection.appendItem({ type: "function_call_output", call_id: id, output });
}

class HistoryProjection {
  readonly items: JsonValue[] = [];
  readonly pending = new Map<string, string>();
  completedResults = 0;
  omitted = false;
  bytes = 0;

  constructor(
    private readonly seenCallIds: Set<string>,
    private readonly oversized: "reject" | "omit",
  ) {}

  append(message: AgentMessage): void {
    if (message.role === "user") {
      projectUserMessage(message, this);
    } else if (message.role === "assistant") {
      projectAssistantMessage(message, this);
    } else if (message.role === "toolResult") {
      projectToolResult(message, this);
    } else {
      throw new CodexHistoryRejection("unsupported_content");
    }
  }

  recordCall(id: string, name: string): void {
    if (this.seenCallIds.has(id)) {
      throw new CodexHistoryRejection("invalid_pairing");
    }
    this.seenCallIds.add(id);
    this.pending.set(id, name);
  }

  recordResult(id: string, name: string): void {
    if (this.pending.get(id) !== name) {
      throw new CodexHistoryRejection("invalid_pairing");
    }
    this.pending.delete(id);
    this.completedResults += 1;
  }

  exceedLimit(reason: "item_limit" | "byte_limit" | "field_limit"): void {
    if (this.oversized === "reject") {
      throw new CodexHistoryRejection(reason);
    }
    // Keep parsing this message and group after releasing their replay payload.
    this.omitted = true;
    this.items.length = 0;
    this.bytes = 0;
  }

  appendItem(item: JsonValue): void {
    if (this.omitted) {
      return;
    }
    if (this.items.length === MAX_RESPONSE_ITEMS) {
      this.exceedLimit("item_limit");
      return;
    }
    this.bytes += responseItemBytes(item);
    if (this.bytes > MAX_PROJECTION_BYTES) {
      this.exceedLimit("byte_limit");
      return;
    }
    this.items.push(item);
  }

  finish(): void {
    if (this.pending.size) {
      throw new CodexHistoryRejection("incomplete_pairing");
    }
  }
}

/** Current-turn evidence must be complete; it is never trimmed to fit a budget. */
export function projectSettledCodexMessages(
  messages: Iterable<AgentMessage>,
  seenCallIds = new Set<string>(),
): JsonValue[] {
  const projection = new HistoryProjection(seenCallIds, "reject");
  for (const message of messages) {
    projection.append(message);
  }
  projection.finish();
  if (projection.completedResults === 0) {
    throw new CodexHistoryRejection("incomplete_pairing");
  }
  return projection.items;
}

const OMITTED_HISTORY: JsonValue = {
  type: "message",
  role: "user",
  content: [
    {
      type: "input_text",
      text:
        "[Earlier conversation was omitted from this bounded recovery context. " +
        "The current turn's evidence is complete. Do not infer missing earlier facts; " +
        "state uncertainty when the available context is insufficient.]",
    },
  ],
};

/** Keep the nearest whole prior turns, reserving the budget for current evidence. */
export class SettledTurnPriorContext {
  private groups: HistoryProjection[] = [];
  private active: HistoryProjection;
  private omitted = false;
  private count = 0;
  private bytes = 0;

  constructor(private readonly seenCallIds: Set<string>) {
    this.active = new HistoryProjection(seenCallIds, "omit");
  }

  append(message: AgentMessage): void {
    // A user message while a tool is in flight steers the same atomic group.
    if (message.role === "user" && this.active.pending.size === 0) {
      this.finishGroup();
      this.active = new HistoryProjection(this.seenCallIds, "omit");
    }
    const wasOmitted = this.active.omitted;
    this.active.append(message);
    if (!wasOmitted && this.active.omitted) {
      // An oversized prior turn is omitted as a whole, not replayed as a partial
      // tool exchange. Older groups are no longer a contiguous context suffix.
      this.groups = [];
      this.count = 0;
      this.bytes = 0;
      this.omitted = true;
    }
  }

  private finishGroup(): void {
    this.active.finish();
    if (this.active.items.length) {
      this.groups.push(this.active);
      this.count += this.active.items.length;
      this.bytes += this.active.bytes;
      this.trim(0, 0);
    }
  }

  private trim(currentCount: number, currentBytes: number): boolean {
    while (
      this.count + currentCount + (this.omitted ? 1 : 0) > MAX_RESPONSE_ITEMS ||
      this.bytes + currentBytes + (this.omitted ? responseItemBytes(OMITTED_HISTORY) : 0) >
        MAX_PROJECTION_BYTES
    ) {
      const oldest = this.groups.shift();
      if (!oldest) {
        // Current evidence already passed its own limits. Only the advisory
        // notice cannot fit; the finalizer instructions also warn about omissions.
        return false;
      }
      this.count -= oldest.items.length;
      this.bytes -= oldest.bytes;
      this.omitted = true;
    }
    return this.omitted;
  }

  prependTo(current: JsonValue[]): JsonValue[] {
    this.finishGroup();
    const includeNotice = this.trim(
      current.length,
      current.reduce<number>((bytes, item) => bytes + responseItemBytes(item), 0),
    );
    return [
      ...(includeNotice ? [OMITTED_HISTORY] : []),
      ...this.groups.flatMap((group) => group.items),
      ...current,
    ];
  }
}
