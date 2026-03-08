/**
 * after_tool_call hook handler for real-time usage tracking.
 * NEVER throws — all errors are caught and logged.
 */

import type { PluginLogger } from "openclaw/plugin-sdk";
import { classifyReadPath } from "./classifier.js";
import type { UsageRecord, UsageStorage } from "./storage.js";

/**
 * Create the after_tool_call hook handler.
 * Uses inline types to avoid import issues with unexported plugin hook types.
 */
export function createAfterToolCallHandler(storage: UsageStorage, logger: PluginLogger) {
  return (
    event: {
      toolName: string;
      params: Record<string, unknown>;
      result?: unknown;
      error?: string;
      durationMs?: number;
    },
    ctx: { agentId?: string; sessionKey?: string; toolName: string },
  ): void => {
    try {
      const now = Math.floor(Date.now() / 1000);

      const record: UsageRecord = {
        ts: now,
        tool: event.toolName,
        session: ctx.sessionKey,
        agent: ctx.agentId,
        dur: event.durationMs,
      };

      if (event.error) {
        record.err = event.error.slice(0, 200);
      }

      // Classify read tool calls for skill detection
      if (event.toolName === "read" || event.toolName === "Read") {
        const filePath =
          typeof event.params?.file_path === "string"
            ? event.params.file_path
            : typeof event.params?.path === "string"
              ? event.params.path
              : undefined;

        if (filePath) {
          record.path = filePath;
          const classification = classifyReadPath(filePath);
          if (classification.isSkill) {
            record.skill = classification.skill;
            record.skillType = classification.skillType;
          }
        }
      }

      storage.append(record);
    } catch (err) {
      logger.error(`usage-tracker hook error: ${String(err)}`);
    }
  };
}
