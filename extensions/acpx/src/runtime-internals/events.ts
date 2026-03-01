import type { AcpRuntimeEvent, AcpSessionUpdateTag } from "openclaw/plugin-sdk";
import { isAcpJsonRpcMessage, normalizeJsonRpcId } from "./jsonrpc.js";
import {
  asOptionalString,
  asString,
  asTrimmedString,
  type AcpxJsonObject,
  isRecord,
} from "./shared.js";

export function parseJsonLines(value: string): AcpxJsonObject[] {
  const events: AcpxJsonObject[] = [];
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) {
        events.push(parsed);
      }
    } catch {
      // Ignore malformed lines; callers handle missing typed events via exit code.
    }
  }
  return events;
}

function asOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parsePromptStopReason(message: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(message, "result")) {
    return undefined;
  }
  const result = isRecord(message.result) ? message.result : null;
  if (!result) {
    return undefined;
  }
  const stopReason = asString(result.stopReason);
  return stopReason && stopReason.trim().length > 0 ? stopReason : undefined;
}

function resolveTextChunk(params: {
  update: Record<string, unknown>;
  stream: "output" | "thought";
  tag: AcpSessionUpdateTag;
}): AcpRuntimeEvent | null {
  const contentRaw = params.update.content;
  if (isRecord(contentRaw)) {
    const contentType = asTrimmedString(contentRaw.type);
    if (contentType && contentType !== "text") {
      return null;
    }
    const text = asString(contentRaw.text);
    if (text && text.length > 0) {
      return {
        type: "text_delta",
        text,
        stream: params.stream,
        tag: params.tag,
      };
    }
  }

  const text = asString(params.update.text);
  if (!text || text.length === 0) {
    return null;
  }
  return {
    type: "text_delta",
    text,
    stream: params.stream,
    tag: params.tag,
  };
}

function resolveStatusTextForTag(params: {
  tag: AcpSessionUpdateTag;
  update: Record<string, unknown>;
}): string | null {
  const { tag, update } = params;
  if (tag === "available_commands_update") {
    const commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
    return commands.length > 0
      ? `available commands updated (${commands.length})`
      : "available commands updated";
  }
  if (tag === "current_mode_update") {
    const mode =
      asTrimmedString(update.currentModeId) ||
      asTrimmedString(update.modeId) ||
      asTrimmedString(update.mode);
    return mode ? `mode updated: ${mode}` : "mode updated";
  }
  if (tag === "config_option_update") {
    const id = asTrimmedString(update.id) || asTrimmedString(update.configOptionId);
    const value =
      asTrimmedString(update.currentValue) ||
      asTrimmedString(update.value) ||
      asTrimmedString(update.optionValue);
    if (id && value) {
      return `config updated: ${id}=${value}`;
    }
    if (id) {
      return `config updated: ${id}`;
    }
    return "config updated";
  }
  if (tag === "session_info_update") {
    return asTrimmedString(update.summary) || asTrimmedString(update.message) || "session updated";
  }
  if (tag === "plan") {
    const entries = Array.isArray(update.entries) ? update.entries : [];
    const first = entries.find((entry) => isRecord(entry)) as Record<string, unknown> | undefined;
    const content = asTrimmedString(first?.content);
    if (!content) {
      return "plan updated";
    }
    const status = asTrimmedString(first?.status);
    return status ? `plan: [${status}] ${content}` : `plan: ${content}`;
  }
  return null;
}

function parseSessionUpdateEvent(message: Record<string, unknown>): AcpRuntimeEvent | null {
  if (asTrimmedString(message.method) !== "session/update") {
    return null;
  }
  const params = isRecord(message.params) ? message.params : null;
  if (!params) {
    return null;
  }
  const update = isRecord(params.update) ? params.update : null;
  if (!update) {
    return null;
  }

  const tag = asOptionalString(update.sessionUpdate) as AcpSessionUpdateTag | undefined;
  if (!tag) {
    return null;
  }

  switch (tag) {
    case "agent_message_chunk":
      return resolveTextChunk({
        update,
        stream: "output",
        tag,
      });
    case "agent_thought_chunk":
      return resolveTextChunk({
        update,
        stream: "thought",
        tag,
      });
    case "tool_call":
    case "tool_call_update": {
      const title = asTrimmedString(update.title) || "tool call";
      const status = asTrimmedString(update.status);
      const toolCallId = asOptionalString(update.toolCallId);
      return {
        type: "tool_call",
        text: status ? `${title} (${status})` : title,
        tag,
        ...(toolCallId ? { toolCallId } : {}),
        ...(status ? { status } : {}),
        title,
      };
    }
    case "usage_update": {
      const used = asOptionalFiniteNumber(update.used);
      const size = asOptionalFiniteNumber(update.size);
      return {
        type: "status",
        text: used != null && size != null ? `usage updated: ${used}/${size}` : "usage updated",
        tag,
        ...(used != null ? { used } : {}),
        ...(size != null ? { size } : {}),
      };
    }
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "plan": {
      const text = resolveStatusTextForTag({
        tag,
        update,
      });
      if (!text) {
        return null;
      }
      return {
        type: "status",
        text,
        tag,
      };
    }
    default:
      return null;
  }
}

export class PromptStreamProjector {
  private readonly promptRequestIds = new Set<string>();

  ingestLine(line: string): AcpRuntimeEvent | null {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {
        type: "status",
        text: trimmed,
      };
    }

    if (!isRecord(parsed) || !isAcpJsonRpcMessage(parsed)) {
      return null;
    }

    if (asTrimmedString(parsed.method) === "session/prompt") {
      const id = normalizeJsonRpcId(parsed.id);
      if (id) {
        this.promptRequestIds.add(id);
      }
      return null;
    }

    const updateEvent = parseSessionUpdateEvent(parsed);
    if (updateEvent) {
      return this.promptRequestIds.size > 0 ? updateEvent : null;
    }

    if (Object.hasOwn(parsed, "error")) {
      if (!this.consumePromptResponse(parsed)) {
        return null;
      }
      const error = isRecord(parsed.error) ? parsed.error : null;
      const message = asTrimmedString(error?.message);
      const codeValue = error?.code;
      return {
        type: "error",
        message: message || "acpx runtime error",
        code:
          typeof codeValue === "number" && Number.isFinite(codeValue)
            ? String(codeValue)
            : asOptionalString(codeValue),
      };
    }

    const stopReason = parsePromptStopReason(parsed);
    if (!stopReason || !this.consumePromptResponse(parsed)) {
      return null;
    }

    return {
      type: "done",
      stopReason,
    };
  }

  private consumePromptResponse(message: Record<string, unknown>): boolean {
    const id = normalizeJsonRpcId(message.id);
    if (!id) {
      return false;
    }
    if (!this.promptRequestIds.has(id)) {
      return false;
    }
    this.promptRequestIds.delete(id);
    return true;
  }
}
