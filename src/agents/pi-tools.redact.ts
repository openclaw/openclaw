import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { redactSensitiveText } from "../logging/redact.js";
import { isPlainObject } from "../utils.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value, { mode: "tools" });
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const redacted = redactValue(entry, seen);
      if (redacted !== entry) {
        changed = true;
      }
      return redacted;
    });
    return changed ? next : value;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const redacted = redactValue(entry, seen);
    if (redacted !== entry) {
      changed = true;
    }
    next[key] = redacted;
  }
  return changed ? next : value;
}

export function redactToolResult<T>(result: T): T {
  const redacted = redactValue(result, new WeakSet<object>());
  return redacted as T;
}

export function wrapToolWithResultRedaction(tool: AnyAgentTool): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const wrappedOnUpdate = onUpdate
        ? (partialResult: AgentToolResult<unknown>) => {
            onUpdate(redactToolResult(partialResult));
          }
        : onUpdate;
      const result = await execute(toolCallId, params, signal, wrappedOnUpdate);
      return redactToolResult(result);
    },
  };
}
