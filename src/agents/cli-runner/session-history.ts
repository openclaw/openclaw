import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import {
  limitAgentHookHistoryMessages,
  MAX_AGENT_HOOK_HISTORY_MESSAGES,
} from "../harness/hook-history.js";

export const MAX_CLI_SESSION_HISTORY_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_CLI_SESSION_HISTORY_MESSAGES = MAX_AGENT_HOOK_HISTORY_MESSAGES;

type HistoryMessage = {
  role?: unknown;
  content?: unknown;
};

function coerceHistoryText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" && text.trim().length > 0 ? [text.trim()] : [];
    })
    .join("\n")
    .trim();
}

export function buildCliSessionHistoryPrompt(params: {
  messages: unknown[];
  prompt: string;
}): string | undefined {
  const renderedHistory = params.messages
    .flatMap((message) => {
      if (!message || typeof message !== "object") {
        return [];
      }
      const entry = message as HistoryMessage;
      const role =
        entry.role === "assistant" ? "Assistant" : entry.role === "user" ? "User" : undefined;
      if (!role) {
        return [];
      }
      const text = coerceHistoryText(entry.content);
      return text ? [`${role}: ${text}`] : [];
    })
    .join("\n\n")
    .trim();

  if (!renderedHistory) {
    return undefined;
  }

  return [
    "Continue this conversation using the OpenClaw transcript below as prior session history.",
    "Treat it as authoritative context for this fresh CLI session.",
    "",
    "<conversation_history>",
    renderedHistory,
    "</conversation_history>",
    "",
    "<next_user_message>",
    params.prompt,
    "</next_user_message>",
  ].join("\n");
}

function safeRealpathSync(filePath: string): string | undefined {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return undefined;
  }
}

function isPathWithinBase(basePath: string, targetPath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveSafeCliSessionFile(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): { sessionFile: string; sessionsDir: string } {
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const pathOptions = resolveSessionFilePathOptions({
    agentId: sessionAgentId ?? defaultAgentId,
    storePath: params.config?.session?.store,
  });
  const sessionFile = resolveSessionFilePath(
    params.sessionId,
    { sessionFile: params.sessionFile },
    pathOptions,
  );
  return {
    sessionFile,
    sessionsDir: pathOptions?.sessionsDir ?? path.dirname(sessionFile),
  };
}

export function loadCliSessionHistoryMessages(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): unknown[] {
  try {
    const { sessionFile, sessionsDir } = resolveSafeCliSessionFile(params);
    const entryStat = fs.lstatSync(sessionFile);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      return [];
    }
    const realSessionsDir = safeRealpathSync(sessionsDir) ?? path.resolve(sessionsDir);
    const realSessionFile = safeRealpathSync(sessionFile);
    if (!realSessionFile || !isPathWithinBase(realSessionsDir, realSessionFile)) {
      return [];
    }
    const stat = fs.statSync(realSessionFile);
    if (!stat.isFile() || stat.size > MAX_CLI_SESSION_HISTORY_FILE_BYTES) {
      return [];
    }
    const entries = SessionManager.open(realSessionFile).getEntries();
    const history = entries.flatMap((entry) =>
      entry?.type === "message" ? [entry.message as unknown] : [],
    );
    return limitAgentHookHistoryMessages(history, MAX_CLI_SESSION_HISTORY_MESSAGES);
  } catch {
    return [];
  }
}
