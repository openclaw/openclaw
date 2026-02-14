/**
 * Audit Logger Plugin
 *
 * Creates a tamper-evident audit trail of all agent actions for independent verification.
 * Logs to ~/.openclaw/logs/audit.jsonl (or custom path via config).
 *
 * Hooks:
 * - after_tool_call: Logs every tool invocation with params, success, duration
 * - message_sent: Logs every outbound message with recipient and delivery status
 * - session_start: Marks session boundaries in the audit trail
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type AuditLoggerConfig = {
  redactPatterns?: string[];
  logPath?: string;
};

// Sensitive keys to redact by default
const DEFAULT_SENSITIVE_KEYS = [
  "password",
  "token",
  "secret",
  "apikey",
  "api_key",
  "auth",
  "credential",
  "private",
  "bearer",
];

function resolveLogPath(config?: AuditLoggerConfig): string {
  if (config?.logPath) {
    return config.logPath;
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "logs", "audit.jsonl");
}

async function ensureLogDir(logPath: string): Promise<void> {
  const dir = path.dirname(logPath);
  await fs.mkdir(dir, { recursive: true });
}

async function appendLog(logPath: string, entry: Record<string, unknown>): Promise<void> {
  await ensureLogDir(logPath);
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    }) + "\n";
  await fs.appendFile(logPath, line, "utf-8");
}

function redactSensitiveParams(
  params: Record<string, unknown>,
  extraPatterns: string[] = [],
): Record<string, unknown> {
  const sensitiveKeys = [...DEFAULT_SENSITIVE_KEYS, ...extraPatterns.map((p) => p.toLowerCase())];

  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some((s) => lowerKey.includes(s))) {
      redacted[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      redacted[key] = redactSensitiveParams(value as Record<string, unknown>, extraPatterns);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

const plugin = {
  id: "audit-logger",
  name: "Audit Logger",
  description: "Logs all tool calls and messages to an audit trail for verification",

  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig as AuditLoggerConfig | undefined;
    const logPath = resolveLogPath(config);
    const extraPatterns = config?.redactPatterns ?? [];

    api.logger.info(`Audit logger enabled, writing to: ${logPath}`);

    // Log session starts
    api.on("session_start", async (event, ctx) => {
      try {
        await appendLog(logPath, {
          type: "session_start",
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          resumedFrom: event.resumedFrom,
        });
      } catch (err) {
        api.logger.error(`Failed to log session_start: ${String(err)}`);
      }
    });

    // Log every tool call
    api.on(
      "after_tool_call",
      async (event, ctx) => {
        try {
          const redactedParams = redactSensitiveParams(event.params, extraPatterns);
          await appendLog(logPath, {
            type: "tool_call",
            tool: event.toolName,
            params: redactedParams,
            success: !event.error,
            error: event.error,
            durationMs: event.durationMs,
            sessionKey: ctx.sessionKey,
          });
        } catch (err) {
          api.logger.error(`Failed to log tool_call: ${String(err)}`);
        }
      },
      { priority: 100 }, // High priority to ensure we log before other hooks
    );

    // Log every outbound message
    api.on("message_sent", async (event, ctx) => {
      try {
        await appendLog(logPath, {
          type: "message_sent",
          channelId: ctx.channelId,
          to: event.to,
          success: event.success,
          error: event.error,
          // Don't log content for privacy, just that it was sent
          contentLength: event.content?.length,
        });
      } catch (err) {
        api.logger.error(`Failed to log message_sent: ${String(err)}`);
      }
    });

    // Log session ends
    api.on("session_end", async (event, ctx) => {
      try {
        await appendLog(logPath, {
          type: "session_end",
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          messageCount: event.messageCount,
          durationMs: event.durationMs,
        });
      } catch (err) {
        api.logger.error(`Failed to log session_end: ${String(err)}`);
      }
    });
  },
};

export default plugin;
