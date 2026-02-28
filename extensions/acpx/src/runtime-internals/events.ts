import type { AcpRuntimeEvent } from "openclaw/plugin-sdk";
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

  const sessionUpdate = asTrimmedString(update.sessionUpdate);
  switch (sessionUpdate) {
    case "agent_message_chunk": {
      const content = isRecord(update.content) ? update.content : null;
      if (!content || asTrimmedString(content.type) !== "text") {
        return null;
      }
      const text = asString(content.text);
      if (!text) {
        return null;
      }
      return {
        type: "text_delta",
        text,
        stream: "output",
      };
    }
    case "agent_thought_chunk": {
      const content = isRecord(update.content) ? update.content : null;
      if (!content || asTrimmedString(content.type) !== "text") {
        return null;
      }
      const text = asString(content.text);
      if (!text) {
        return null;
      }
      return {
        type: "text_delta",
        text,
        stream: "thought",
      };
    }
    case "tool_call":
    case "tool_call_update": {
      const title =
        asTrimmedString(update.title) ||
        asTrimmedString(update.toolCallId) ||
        asTrimmedString(update.kind) ||
        "tool";
      const status = asTrimmedString(update.status);
      return {
        type: "tool_call",
        text: status ? `${title} (${status})` : title,
      };
    }
    case "plan": {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const first = entries.find((entry) => isRecord(entry)) as Record<string, unknown> | undefined;
      const content = asTrimmedString(first?.content);
      if (!content) {
        return { type: "status", text: "plan updated" };
      }
      const status = asTrimmedString(first?.status);
      return {
        type: "status",
        text: status ? `plan: [${status}] ${content}` : `plan: ${content}`,
      };
    }
    case "available_commands_update": {
      const commands = Array.isArray(update.availableCommands)
        ? update.availableCommands.length
        : 0;
      return {
        type: "status",
        text: `available commands updated (${commands})`,
      };
    }
    case "current_mode_update": {
      const modeId = asTrimmedString(update.currentModeId);
      return {
        type: "status",
        text: modeId ? `mode updated: ${modeId}` : "mode updated",
      };
    }
    case "config_option_update": {
      const options = Array.isArray(update.configOptions) ? update.configOptions.length : 0;
      return {
        type: "status",
        text: `config options updated (${options})`,
      };
    }
    case "session_info_update": {
      const title = asTrimmedString(update.title);
      return {
        type: "status",
        text: title ? `session info updated: ${title}` : "session info updated",
      };
    }
    case "usage_update": {
      const used =
        typeof update.used === "number" && Number.isFinite(update.used) ? update.used : null;
      const size =
        typeof update.size === "number" && Number.isFinite(update.size) ? update.size : null;
      if (used == null || size == null) {
        return { type: "status", text: "usage updated" };
      }
      return {
        type: "status",
        text: `usage updated: ${used}/${size}`,
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

    const updateEvent = parseSessionUpdateEvent(parsed);
    if (updateEvent) {
      return updateEvent;
    }

    if (asTrimmedString(parsed.method) === "session/prompt") {
      const id = normalizeJsonRpcId(parsed.id);
      if (id) {
        this.promptRequestIds.add(id);
      }
      return null;
    }

    if (Object.hasOwn(parsed, "error")) {
      if (!this.shouldHandlePromptResponse(parsed)) {
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
    if (!stopReason || !this.shouldHandlePromptResponse(parsed)) {
      return null;
    }

    return {
      type: "done",
      stopReason,
    };
  }

  private shouldHandlePromptResponse(message: Record<string, unknown>): boolean {
    const id = normalizeJsonRpcId(message.id);
    if (!id) {
      return false;
    }
    return this.promptRequestIds.has(id);
  }
}
