/**
 * Claude SDK Session Store — Adapts session persistence for the Claude Agent SDK.
 *
 * The Claude Agent SDK manages its own session files at ~/.claude/projects/.
 * This module provides utilities for:
 * 1. Mapping between OpenClaw session IDs and Claude SDK session IDs
 * 2. Reading session transcripts from the SDK's format
 * 3. Bridging metadata that OpenClaw tracks but the SDK doesn't
 *
 * Key difference: The pi-agent path uses OpenClaw's own JSONL files
 * (managed by SessionManager). The Claude SDK path uses the SDK subprocess's
 * built-in persistence. This store bridges the gap.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeMessage, SessionStore } from "./types.js";

/**
 * Session store that delegates to the Claude Agent SDK's built-in persistence.
 *
 * The SDK writes sessions to ~/.claude/projects/<project-hash>/sessions/<session-id>.jsonl
 * This store reads from that location and provides a unified interface.
 */
export class ClaudeSessionStore implements SessionStore {
  private sessionId: string;
  private claudeProjectDir: string;

  constructor(params: { sessionId: string; cwd: string }) {
    this.sessionId = params.sessionId;
    // The SDK stores sessions relative to ~/.claude/projects/
    // The exact path depends on the project hash, but we can discover it.
    this.claudeProjectDir = resolveClaudeProjectDir(params.cwd);
  }

  async load(): Promise<RuntimeMessage[]> {
    const sessionFile = this.resolveSessionFile();
    try {
      const content = await fs.readFile(sessionFile, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      const messages: RuntimeMessage[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const msg = sdkEntryToRuntimeMessage(entry);
          if (msg) {
            messages.push(msg);
          }
        } catch {
          // Skip malformed lines
        }
      }

      return messages;
    } catch (err) {
      if ((err as { code?: string })?.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async save(_messages: RuntimeMessage[]): Promise<void> {
    // The SDK manages its own persistence — we don't write to its session files.
    // This is a no-op. OpenClaw's metadata is tracked separately.
  }

  async append(_entry: unknown): Promise<void> {
    // The SDK manages its own persistence.
  }

  async compact(_summary: string): Promise<void> {
    // Compaction is handled by the SDK subprocess internally.
    // It emits "compacting" status events when doing so.
  }

  async branch(_newSessionFile: string): Promise<void> {
    // The SDK supports forking via the `forkSession` option.
    // This would be handled at the query() level, not here.
  }

  private resolveSessionFile(): string {
    return path.join(this.claudeProjectDir, "sessions", `${this.sessionId}.jsonl`);
  }
}

/**
 * Resolve the Claude SDK's project directory for a given working directory.
 * The SDK uses a hash of the project path.
 */
function resolveClaudeProjectDir(cwd: string): string {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  // The SDK hashes the project path — for now use a simple approach.
  // The actual hash algorithm is internal to the SDK, but sessions
  // are discoverable via the SDK's session management APIs.
  const projectHash = simpleHash(cwd);
  return path.join(homeDir, ".claude", "projects", projectHash);
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Convert a Claude SDK session JSONL entry to a RuntimeMessage.
 * Returns null for entries that don't map to messages (system events, etc.).
 */
function sdkEntryToRuntimeMessage(entry: unknown): RuntimeMessage | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const e = entry as { type?: string; message?: unknown; role?: string };

  if (e.type === "user" && e.message) {
    return {
      role: "user",
      content: extractContentText(e.message),
      raw: entry,
    };
  }

  if (e.type === "assistant" && e.message) {
    return {
      role: "assistant",
      content: extractContentText(e.message),
      raw: entry,
    };
  }

  return null;
}

function extractContentText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const m = message as { content?: unknown; role?: string };

  if (typeof m.content === "string") {
    return m.content;
  }
  if (!Array.isArray(m.content)) {
    return "";
  }

  return (m.content as Array<{ type?: string; text?: string }>)
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!)
    .join("");
}
