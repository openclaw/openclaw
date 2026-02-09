/**
 * Session persistence using append-only JSONL files.
 * Pattern from OpenClaw — each agent gets its own session file.
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface SessionHeader {
  version: number;
  agentId: string;
  model: string;
  createdAt: string;
}

export interface SessionMessage {
  timestamp: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SessionEntry {
  totalTokens: number;
  compactionCount: number;
  memoryFlushCompactionCount?: number;
  messageCount: number;
}

const CURRENT_VERSION = 1;

/**
 * Append a message to a JSONL session transcript.
 */
export async function appendToSession(
  sessionDir: string,
  sessionKey: string,
  message: SessionMessage,
): Promise<void> {
  const filePath = path.join(sessionDir, `${sessionKey}.jsonl`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify(message) + "\n";
  await fs.appendFile(filePath, line, "utf-8");
}

/**
 * Create a new session file with a header.
 */
export async function createSession(
  sessionDir: string,
  sessionKey: string,
  agentId: string,
  model: string,
): Promise<void> {
  const filePath = path.join(sessionDir, `${sessionKey}.jsonl`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const header: SessionHeader = {
    version: CURRENT_VERSION,
    agentId,
    model,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(filePath, JSON.stringify(header) + "\n", "utf-8");
}

/**
 * Read all messages from a session transcript.
 */
export async function readSession(
  sessionDir: string,
  sessionKey: string,
): Promise<SessionMessage[]> {
  const filePath = path.join(sessionDir, `${sessionKey}.jsonl`);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = raw.trim().split("\n").filter(Boolean);
  const messages: SessionMessage[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      // Skip header (has version field)
      if (parsed.version !== undefined) continue;
      if (parsed.role && parsed.content !== undefined) {
        messages.push(parsed as SessionMessage);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages;
}

/**
 * List all session keys in a directory.
 */
export async function listSessions(sessionDir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(sessionDir);
    return files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""));
  } catch {
    return [];
  }
}
