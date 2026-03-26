import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { OpenClawPluginApi } from "../../api.js";

interface AopEvent {
  timestamp: string;
  event: string;
  sessionKey?: string;
  data?: Record<string, unknown>;
}

function resolveLogFile(api: OpenClawPluginApi): string {
  const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
  return (pluginConfig?.aopLogFile as string) || join(homedir(), ".openclaw", "all.jsonl");
}

async function emitAopEvent(api: OpenClawPluginApi, event: AopEvent): Promise<void> {
  const logFile = resolveLogFile(api);
  try {
    await mkdir(dirname(logFile), { recursive: true });
    await appendFile(logFile, JSON.stringify(event) + "\n", "utf-8");
  } catch (err) {
    api.logger.warn(`Failed to write AOP event: ${err}`);
  }
}

export function registerSessionObservability(api: OpenClawPluginApi): void {
  const toolCounts = new Map<string, number>();

  api.on("session_start", async (event) => {
    const sessionKey = (event as Record<string, unknown>).sessionKey as string | undefined;
    if (sessionKey) toolCounts.set(sessionKey, 0);

    await emitAopEvent(api, {
      timestamp: new Date().toISOString(),
      event: "agentic.session_start",
      sessionKey,
      data: {
        source: "telegram-agentic",
      },
    });
  });

  api.on("before_tool_call", async (event) => {
    const ev = event as Record<string, unknown>;
    const sessionKey = ev.sessionKey as string | undefined;
    const toolName = ev.toolName as string | undefined;

    if (sessionKey) {
      toolCounts.set(sessionKey, (toolCounts.get(sessionKey) || 0) + 1);
    }

    await emitAopEvent(api, {
      timestamp: new Date().toISOString(),
      event: "agentic.tool_start",
      sessionKey,
      data: {
        toolName,
        toolRound: toolCounts.get(sessionKey || "") || 0,
      },
    });
  });

  api.on("after_tool_call", async (event) => {
    const ev = event as Record<string, unknown>;
    const sessionKey = ev.sessionKey as string | undefined;
    const toolName = ev.toolName as string | undefined;
    const durationMs = ev.durationMs as number | undefined;

    await emitAopEvent(api, {
      timestamp: new Date().toISOString(),
      event: "agentic.tool_end",
      sessionKey,
      data: {
        toolName,
        durationMs,
      },
    });
  });

  api.on("session_end", async (event) => {
    const ev = event as Record<string, unknown>;
    const sessionKey = ev.sessionKey as string | undefined;
    const toolCount = toolCounts.get(sessionKey || "") || 0;

    await emitAopEvent(api, {
      timestamp: new Date().toISOString(),
      event: "agentic.session_end",
      sessionKey,
      data: {
        toolCount,
        source: "telegram-agentic",
      },
    });

    if (sessionKey) toolCounts.delete(sessionKey);
  });
}
