import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("claude-code-sessions");

/**
 * Session key format: agent:claude-code:workspace:{hash}
 * where hash is the first 16 chars of SHA-256 of the normalized workspace path.
 */
export function generateClaudeCodeSessionKey(workspacePath: string): string {
  const normalizedPath = path.resolve(workspacePath);
  const hash = crypto.createHash("sha256").update(normalizedPath).digest("hex").slice(0, 16);
  return `agent:claude-code:workspace:${hash}`;
}

/**
 * Parse a claude-code session key to extract the workspace hash.
 */
export function parseClaudeCodeSessionKey(sessionKey: string): { workspaceHash: string } | null {
  const match = sessionKey.match(/^agent:claude-code:workspace:([a-f0-9]{16})$/);
  if (!match) {
    return null;
  }
  return { workspaceHash: match[1] };
}

/**
 * Check if a session key is a claude-code workspace session.
 */
export function isClaudeCodeSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith("agent:claude-code:workspace:");
}

/**
 * Persistent mapping from workspace path to session key.
 * Stored in ~/.openclaw/claude-code-sessions.json
 */
type SessionMapping = {
  workspacePath: string;
  sessionKey: string;
  claudeSessionId?: string; // Claude CLI session ID for conversation continuity
  createdAt: number;
  lastUsedAt: number;
};

type SessionsStore = {
  version: 1;
  sessions: Record<string, SessionMapping>; // key: workspace hash
};

function getSessionsFilePath(): string {
  const openclawDir = path.join(os.homedir(), ".openclaw");
  return path.join(openclawDir, "claude-code-sessions.json");
}

function loadSessionsStore(): SessionsStore {
  const filePath = getSessionsFilePath();
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(content) as SessionsStore;
    if (data.version !== 1) {
      log.warn(`Unknown sessions store version: ${String(data.version)}, resetting`);
      return { version: 1, sessions: {} };
    }
    return data;
  } catch {
    return { version: 1, sessions: {} };
  }
}

function saveSessionsStore(store: SessionsStore): void {
  const filePath = getSessionsFilePath();
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    log.warn(`Failed to save claude-code sessions: ${String(err)}`);
  }
}

/**
 * Get or create a session key for a workspace.
 * If resume is true, returns existing session if available.
 * Otherwise, always creates a new session key.
 */
export function resolveClaudeCodeSession(params: { workspacePath: string; resume?: boolean }): {
  sessionKey: string;
  isNew: boolean;
} {
  const { workspacePath, resume } = params;
  const normalizedPath = path.resolve(workspacePath);
  const hash = crypto.createHash("sha256").update(normalizedPath).digest("hex").slice(0, 16);

  if (resume) {
    const store = loadSessionsStore();
    const existing = store.sessions[hash];
    if (existing) {
      // Update last used time
      existing.lastUsedAt = Date.now();
      saveSessionsStore(store);
      return { sessionKey: existing.sessionKey, isNew: false };
    }
  }

  // Create new session
  const sessionKey = generateClaudeCodeSessionKey(normalizedPath);
  const now = Date.now();
  const store = loadSessionsStore();
  store.sessions[hash] = {
    workspacePath: normalizedPath,
    sessionKey,
    createdAt: now,
    lastUsedAt: now,
  };
  saveSessionsStore(store);

  return { sessionKey, isNew: true };
}

/**
 * List all known claude-code sessions.
 */
export function listClaudeCodeSessions(): SessionMapping[] {
  const store = loadSessionsStore();
  return Object.values(store.sessions);
}

/**
 * Delete a session mapping by workspace path.
 */
export function deleteClaudeCodeSession(workspacePath: string): boolean {
  const normalizedPath = path.resolve(workspacePath);
  const hash = crypto.createHash("sha256").update(normalizedPath).digest("hex").slice(0, 16);
  const store = loadSessionsStore();
  if (store.sessions[hash]) {
    delete store.sessions[hash];
    saveSessionsStore(store);
    return true;
  }
  return false;
}

/**
 * Clean up old sessions that haven't been used in the specified number of days.
 */
export function cleanupOldSessions(maxAgeDays: number = 30): number {
  const store = loadSessionsStore();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;
  for (const [hash, session] of Object.entries(store.sessions)) {
    if (session.lastUsedAt < cutoff) {
      delete store.sessions[hash];
      cleaned += 1;
    }
  }
  if (cleaned > 0) {
    saveSessionsStore(store);
    log.info(`Cleaned up ${cleaned} old claude-code sessions`);
  }
  return cleaned;
}

/**
 * Update the Claude CLI session ID for a workspace.
 * This enables conversation continuity across multiple spawns.
 */
export function updateClaudeSessionId(workspacePath: string, claudeSessionId: string): boolean {
  const normalizedPath = path.resolve(workspacePath);
  const hash = crypto.createHash("sha256").update(normalizedPath).digest("hex").slice(0, 16);
  log.debug(
    `updateClaudeSessionId: normalizedPath=${normalizedPath}, hash=${hash}, claudeSessionId=${claudeSessionId}`,
  );
  const store = loadSessionsStore();
  const session = store.sessions[hash];
  if (!session) {
    log.warn(`updateClaudeSessionId: no session found for hash=${hash}, creating new entry`);
    // Create a new session entry if none exists
    const sessionKey = generateClaudeCodeSessionKey(normalizedPath);
    const now = Date.now();
    store.sessions[hash] = {
      workspacePath: normalizedPath,
      sessionKey,
      createdAt: now,
      lastUsedAt: now,
      claudeSessionId,
    };
    saveSessionsStore(store);
    log.info(
      `updateClaudeSessionId: created new session entry for ${normalizedPath}: ${claudeSessionId}`,
    );
    return true;
  }
  session.claudeSessionId = claudeSessionId;
  session.lastUsedAt = Date.now();
  saveSessionsStore(store);
  log.info(
    `updateClaudeSessionId: updated claude session ID for ${normalizedPath}: ${claudeSessionId}`,
  );
  return true;
}

/**
 * Get the Claude CLI session ID for a workspace.
 */
export function getClaudeSessionId(workspacePath: string): string | undefined {
  const normalizedPath = path.resolve(workspacePath);
  const hash = crypto.createHash("sha256").update(normalizedPath).digest("hex").slice(0, 16);
  const store = loadSessionsStore();
  const sessionId = store.sessions[hash]?.claudeSessionId;
  log.debug(
    `getClaudeSessionId: normalizedPath=${normalizedPath}, hash=${hash}, sessionId=${sessionId ?? "none"}`,
  );
  return sessionId;
}
