import type { AcpRuntimeEvent } from "openclaw/plugin-sdk";
import {
  asOptionalBoolean,
  asOptionalString,
  asString,
  asTrimmedString,
  type AcpxErrorEvent,
  type AcpxJsonObject,
  isRecord,
} from "./shared.js";

export function toAcpxErrorEvent(value: unknown): AcpxErrorEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  if (asTrimmedString(value.type) !== "error") {
    return null;
  }
  return {
    message: asTrimmedString(value.message) || "acpx reported an error",
    code: asOptionalString(value.code),
    retryable: asOptionalBoolean(value.retryable),
  };
}

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

export function parsePromptEventLine(line: string): AcpRuntimeEvent | null {
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

  if (!isRecord(parsed)) {
    return null;
  }

  const type = asTrimmedString(parsed.type);
  switch (type) {
    case "text": {
      const content = asString(parsed.content);
      if (content == null || content.length === 0) {
        return null;
      }
      return {
        type: "text_delta",
        text: content,
        stream: "output",
      };
    }
    case "thought": {
      const content = asString(parsed.content);
      if (content == null || content.length === 0) {
        return null;
      }
      return {
        type: "text_delta",
        text: content,
        stream: "thought",
      };
    }
    case "tool_call": {
      const title = asTrimmedString(parsed.title) || asTrimmedString(parsed.toolCallId) || "tool";
      const status = asTrimmedString(parsed.status);
      return {
        type: "tool_call",
        text: status ? `${title} (${status})` : title,
      };
    }
    case "client_operation": {
      const method = asTrimmedString(parsed.method) || "operation";
      const status = asTrimmedString(parsed.status);
      const summary = asTrimmedString(parsed.summary);
      const text = [method, status, summary].filter(Boolean).join(" ");
      if (!text) {
        return null;
      }
      return { type: "status", text };
    }
    case "plan": {
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      const first = entries.find((entry) => isRecord(entry)) as Record<string, unknown> | undefined;
      const content = asTrimmedString(first?.content);
      if (!content) {
        return null;
      }
      return { type: "status", text: `plan: ${content}` };
    }
    case "update": {
      const update = asTrimmedString(parsed.update);
      if (!update) {
        return null;
      }
      return { type: "status", text: update };
    }
    case "done": {
      return {
        type: "done",
        stopReason: asOptionalString(parsed.stopReason),
      };
    }
    case "error": {
      const message = asTrimmedString(parsed.message) || "acpx runtime error";
      return {
        type: "error",
        message,
        code: asOptionalString(parsed.code),
        retryable: asOptionalBoolean(parsed.retryable),
      };
    }
    default:
      return null;
  }
}
