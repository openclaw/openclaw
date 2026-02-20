/**
 * Session registry for Claude Code spawn mode.
 *
 * Maintains a simple `(agentId, repoPath[, label]) → sessionId` mapping persisted to disk.
 * Session files live in Claude Code's native store at `~/.claude/projects/`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeCodeSessionEntry, ClaudeCodeSessionRegistry } from "./types.js";

// ---------------------------------------------------------------------------
// Registry file path
// ---------------------------------------------------------------------------

function registryDir(agentId: string): string {
  return path.join(os.homedir(), ".openclaw", "agents", agentId);
}

function registryPath(agentId: string): string {
  return path.join(registryDir(agentId), "claude-code-sessions.json");
}

// ---------------------------------------------------------------------------
// Registry key helper
// ---------------------------------------------------------------------------

/**
 * Build the registry key for a session.
 * Without a label, this is just the repoPath (backwards compatible).
 * With a label, it's `repoPath::label` — allowing parallel named sessions
 * on the same repo.
 */
export function registryKey(repoPath: string, label?: string): string {
  return label ? `${repoPath}::${label}` : repoPath;
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

function loadRegistry(agentId: string): ClaudeCodeSessionRegistry {
  const filePath = registryPath(agentId);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.sessions) {
      return parsed as ClaudeCodeSessionRegistry;
    }
  } catch {
    // File missing or corrupt — start fresh.
  }
  return { sessions: {} };
}

function saveRegistry(agentId: string, registry: ClaudeCodeSessionRegistry): void {
  const dir = registryDir(agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryPath(agentId), JSON.stringify(registry, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// CC session file resolution
// ---------------------------------------------------------------------------

/**
 * Attempt to locate the CC session file in `~/.claude/projects/`.
 *
 * Claude Code slugifies the project path. The exact algorithm is internal to CC,
 * so we try the most common patterns. If we can't find the file, the session is
 * assumed to have been cleaned up.
 */
/**
 * Locate the CC session JSONL file path, or return undefined if not found.
 */
function findCcSessionFile(repoPath: string, sessionId: string): string | undefined {
  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(claudeDir)) {
    return undefined;
  }

  // CC uses the project path as a directory slug. Try a few variants.
  const candidates = [
    // Most common: the base directory name
    path.basename(repoPath),
    // Full path with slashes replaced
    repoPath.replace(/^\//, "").replace(/\//g, "-"),
  ];

  for (const slug of candidates) {
    const sessionFile = path.join(claudeDir, slug, `${sessionId}.jsonl`);
    if (fs.existsSync(sessionFile)) {
      return sessionFile;
    }
  }

  // Broad search: look through all subdirs for a matching session file.
  try {
    const dirs = fs.readdirSync(claudeDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) {
        continue;
      }
      const sessionFile = path.join(claudeDir, dir.name, `${sessionId}.jsonl`);
      if (fs.existsSync(sessionFile)) {
        return sessionFile;
      }
    }
  } catch {
    // ignore
  }

  return undefined;
}

function ccSessionFileExists(repoPath: string, sessionId: string): boolean {
  return findCcSessionFile(repoPath, sessionId) != null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up an existing CC session for the given agent + repo (+ optional label).
 * Returns the session ID if found and the session file still exists, otherwise undefined.
 */
export function resolveSession(
  agentId: string,
  repoPath: string,
  label?: string,
): string | undefined {
  const key = registryKey(repoPath, label);
  const registry = loadRegistry(agentId);
  const entry = registry.sessions[key];
  if (!entry) {
    return undefined;
  }

  // Verify the session file still exists (CC cleanup may have removed it).
  if (!ccSessionFileExists(repoPath, entry.sessionId)) {
    delete registry.sessions[key];
    saveRegistry(agentId, registry);
    return undefined;
  }

  return entry.sessionId;
}

/**
 * Record a session in the registry.
 */
export function saveSession(
  agentId: string,
  repoPath: string,
  sessionId: string,
  meta?: {
    userId?: string;
    channel?: string;
    task?: string;
    costUsd?: number;
    label?: string;
  },
): void {
  const key = registryKey(repoPath, meta?.label);
  const registry = loadRegistry(agentId);
  const now = new Date().toISOString();
  const existing = registry.sessions[key];

  if (existing && existing.sessionId === sessionId) {
    // Update existing entry.
    existing.lastResumedAt = now;
    if (meta?.costUsd) {
      existing.totalCostUsd += meta.costUsd;
    }
    if (meta?.task) {
      existing.taskHistory.push({
        at: now,
        task: meta.task,
        costUsd: meta.costUsd ?? 0,
      });
    }
  } else {
    // New entry.
    registry.sessions[key] = {
      sessionId,
      createdAt: now,
      lastResumedAt: now,
      totalCostUsd: meta?.costUsd ?? 0,
      totalTurns: 0,
      triggeredBy: {
        userId: meta?.userId,
        channel: meta?.channel,
      },
      taskHistory: meta?.task ? [{ at: now, task: meta.task, costUsd: meta.costUsd ?? 0 }] : [],
      label: meta?.label,
    };
  }

  saveRegistry(agentId, registry);
}

/**
 * Update turn count and cost after a run completes.
 */
export function updateSessionStats(
  agentId: string,
  repoPath: string,
  stats: { turns?: number; costUsd?: number },
  label?: string,
): void {
  const key = registryKey(repoPath, label);
  const registry = loadRegistry(agentId);
  const entry = registry.sessions[key];
  if (!entry) {
    return;
  }

  if (stats.turns) {
    entry.totalTurns += stats.turns;
  }
  if (stats.costUsd) {
    entry.totalCostUsd += stats.costUsd;
  }

  saveRegistry(agentId, registry);
}

/**
 * Delete a session entry (manual reset).
 */
export function deleteSession(agentId: string, repoPath: string, label?: string): boolean {
  const key = registryKey(repoPath, label);
  const registry = loadRegistry(agentId);
  if (!registry.sessions[key]) {
    return false;
  }
  delete registry.sessions[key];
  saveRegistry(agentId, registry);
  return true;
}

/**
 * List all sessions for an agent.
 */
export function listSessions(agentId: string): Record<string, ClaudeCodeSessionEntry> {
  const registry = loadRegistry(agentId);
  return registry.sessions;
}

/**
 * List all sessions across all agents.
 * Returns a flat array with agentId attached.
 */
export function listAllSessions(): Array<
  ClaudeCodeSessionEntry & { agentId: string; repoPath: string }
> {
  const results: Array<ClaudeCodeSessionEntry & { agentId: string; repoPath: string }> = [];
  const agentsDir = path.join(os.homedir(), ".openclaw", "agents");
  try {
    if (!fs.existsSync(agentsDir)) {
      return results;
    }
    const dirs = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) {
        continue;
      }
      const agentId = dir.name;
      const sessions = listSessions(agentId);
      for (const [key, entry] of Object.entries(sessions)) {
        // Extract the repoPath from the key (strip ::label suffix if present)
        const repoPath = key.includes("::") ? key.slice(0, key.indexOf("::")) : key;
        results.push({ ...entry, agentId, repoPath });
      }
    }
  } catch {
    // Ignore filesystem errors
  }
  return results;
}

// ---------------------------------------------------------------------------
// Session history peek — read recent messages from a CC session transcript
// ---------------------------------------------------------------------------

interface SessionMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * Read the last N messages from a Claude Code session's JSONL transcript.
 * Returns a compact text summary suitable for injecting as context.
 *
 * Only extracts text content (skips tool_use/tool_result blocks) to keep
 * the context lean. Returns empty string if session can't be found/read.
 */
export function peekSessionHistory(
  repoPath: string,
  sessionId: string,
  opts?: { maxMessages?: number; maxChars?: number },
): string {
  const maxMessages = opts?.maxMessages ?? 6;
  const maxChars = opts?.maxChars ?? 4000;

  const filePath = findCcSessionFile(repoPath, sessionId);
  if (!filePath) {
    return "";
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }

  // Parse JSONL lines, extract text-only messages
  const messages: SessionMessage[] = [];
  const lines = raw.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const msg = entry.message ?? entry;
      const role = msg.role as string;
      if (role !== "user" && role !== "assistant") {
        continue;
      }

      // Extract text content only
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text ?? "");
        text = textParts.join("\n");
      }
      if (!text.trim()) {
        continue;
      }

      messages.push({ role: role, text: text.trim() });
    } catch {
      continue;
    }
  }

  if (messages.length === 0) {
    return "";
  }

  // Take the last N messages
  const recent = messages.slice(-maxMessages);

  // Build a compact summary
  const parts: string[] = [];
  let totalChars = 0;

  for (const msg of recent) {
    const prefix = msg.role === "assistant" ? "CC" : "User";
    let content = msg.text;

    // Truncate individual messages if needed
    const remaining = maxChars - totalChars;
    if (remaining <= 0) {
      break;
    }
    if (content.length > remaining) {
      content = content.slice(0, remaining) + "…";
    }

    parts.push(`[${prefix}]: ${content}`);
    totalChars += content.length;
  }

  return parts.join("\n\n");
}
