/**
 * Session registry for Claude Code spawn mode.
 *
 * Maintains a simple `(agentId, repoPath[, label]) → sessionId` mapping persisted to disk.
 * Session files live in Claude Code's native store at `~/.claude/projects/`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type {
  ClaudeCodeSessionEntry,
  ClaudeCodeSessionRegistry,
  DiscoveredSession,
  JsonlHeader,
} from "./types.js";
import { isClaudeCodeRunning } from "./live-state.js";

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
 * Convert a repo path to CC's project directory slug.
 * CC uses the full path with `/` replaced by `-`.
 * e.g. `/home/fonz/Projects/openclaw` → `-home-fonz-Projects-openclaw`
 */
export function repoPathToSlug(repoPath: string): string {
  return repoPath.replace(/\//g, "-");
}

/**
 * Locate the CC session JSONL file path, or return undefined if not found.
 * Uses the confirmed slug algorithm as the primary path,
 * with a broad-search fallback as safety net.
 */
function findCcSessionFile(repoPath: string, sessionId: string): string | undefined {
  return findSessionJsonlPath(repoPath, sessionId);
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

  const filePath = findSessionJsonlPath(repoPath, sessionId);
  if (!filePath) {
    return "";
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }

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

      messages.push({ role: role as "user" | "assistant", text: text.trim() });
    } catch {
      continue;
    }
  }

  if (messages.length === 0) {
    return "";
  }

  const recent = messages.slice(-maxMessages);
  const parts: string[] = [];
  let totalChars = 0;

  for (const msg of recent) {
    const prefix = msg.role === "assistant" ? "CC" : "User";
    let content = msg.text;
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

// ---------------------------------------------------------------------------
// JSONL header parsing (streaming)
// ---------------------------------------------------------------------------

const ORIGIN_MARKER_RE = /\[openclaw:agent=([^\]]+)\]/;

/**
 * Extract metadata from a CC JSONL session file using streaming readline.
 * Constant memory regardless of file size.
 */
export async function parseJsonlHeader(filePath: string): Promise<JsonlHeader> {
  const result: JsonlHeader = {
    lineCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    compactionCount: 0,
  };

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }
      result.lineCount++;

      try {
        const msg = JSON.parse(line);

        // Extract metadata from first 10 lines
        if (result.lineCount <= 10) {
          if (!result.gitBranch && msg.gitBranch) {
            result.gitBranch = msg.gitBranch;
          }
          if (!result.slug && msg.slug) {
            result.slug = msg.slug;
          }
          if (!result.version && msg.version) {
            result.version = msg.version;
          }
        }

        // Extract first user message as "title" + origin marker
        if (!result.firstUserMessage && msg.type === "user" && msg.message?.content) {
          const text =
            typeof msg.message.content === "string"
              ? msg.message.content
              : Array.isArray(msg.message.content)
                ? (msg.message.content as Array<{ type?: string; text?: string }>).find(
                    (b) => b.type === "text",
                  )?.text
                : undefined;
          if (text) {
            result.firstUserMessage = text.slice(0, 200);
            const markerMatch = text.match(ORIGIN_MARKER_RE);
            if (markerMatch) {
              result.originMarker = markerMatch[1];
            }
          }
        }

        // Accumulate token usage from assistant messages
        if (msg.message?.usage) {
          result.totalInputTokens += msg.message.usage.input_tokens ?? 0;
          result.totalOutputTokens += msg.message.usage.output_tokens ?? 0;
        }

        // Detect auto-compaction events
        if (msg.type === "system" && msg.message?.content) {
          const text =
            typeof msg.message.content === "string"
              ? msg.message.content
              : JSON.stringify(msg.message.content);
          if (text.includes("compress") || text.includes("compact") || text.includes("summary")) {
            result.compactionCount++;
          }
        }
      } catch {
        // Skip non-JSON lines
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return result;
}

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

/**
 * Discover all CC sessions for a repository, merging OpenClaw registries
 * with native CC JSONL storage. Deduplicates by sessionId.
 */
export async function discoverSessions(repoPath: string): Promise<DiscoveredSession[]> {
  const resolved = path.resolve(repoPath);
  const results: DiscoveredSession[] = [];
  const seen = new Set<string>();

  // 1. OpenClaw registries (rich metadata)
  const allRegistrySessions = listAllSessions();
  for (const entry of allRegistrySessions) {
    if (path.resolve(entry.repoPath) !== resolved) {
      continue;
    }
    seen.add(entry.sessionId);

    // Try to parse JSONL for branch/message/capacity info
    const jsonlPath = findSessionJsonlPath(resolved, entry.sessionId);
    let header: JsonlHeader | undefined;
    let fileStat: fs.Stats | undefined;
    if (jsonlPath) {
      try {
        header = await parseJsonlHeader(jsonlPath);
        fileStat = fs.statSync(jsonlPath);
      } catch {
        // JSONL file may be gone or corrupt
      }
    }

    results.push({
      sessionId: entry.sessionId,
      source: "openclaw",
      agentId: entry.agentId,
      repoPath: resolved,
      branch: header?.gitBranch ?? "unknown",
      firstMessage: header?.firstUserMessage ?? "(no message)",
      lastModified: new Date(entry.lastResumedAt),
      messageCount: header?.lineCount ?? 0,
      fileSizeBytes: fileStat?.size ?? 0,
      totalCostUsd: entry.totalCostUsd,
      totalTurns: entry.totalTurns,
      lastTask: entry.taskHistory.length > 0 ? entry.taskHistory.at(-1)?.task : undefined,
      label: entry.label,
      slug: header?.slug,
      isRunning: isClaudeCodeRunning(resolved),
      originMarker: header?.originMarker,
      totalInputTokens: header?.totalInputTokens ?? 0,
      totalOutputTokens: header?.totalOutputTokens ?? 0,
      compactionCount: header?.compactionCount ?? 0,
    });
  }

  // 2. CC native storage (sessions not in any OpenClaw registry)
  const slug = repoPathToSlug(resolved);
  const sessionDir = path.join(os.homedir(), ".claude", "projects", slug);
  if (fs.existsSync(sessionDir)) {
    let files: string[];
    try {
      files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      files = [];
    }

    for (const file of files) {
      const sessionId = path.basename(file, ".jsonl");
      if (seen.has(sessionId)) {
        continue;
      }

      const filePath = path.join(sessionDir, file);
      try {
        const stat = fs.statSync(filePath);
        const header = await parseJsonlHeader(filePath);
        results.push({
          sessionId,
          source: "native-only",
          repoPath: resolved,
          branch: header.gitBranch ?? "unknown",
          firstMessage: header.firstUserMessage ?? "(no message)",
          lastModified: stat.mtime,
          messageCount: header.lineCount,
          fileSizeBytes: stat.size,
          slug: header.slug,
          isRunning: false,
          originMarker: header.originMarker,
          totalInputTokens: header.totalInputTokens,
          totalOutputTokens: header.totalOutputTokens,
          compactionCount: header.compactionCount,
        });
      } catch {
        // Skip files we can't read
      }
    }
  }

  // Sort: running sessions first, then by lastModified descending
  results.sort((a, b) => {
    if (a.isRunning !== b.isRunning) {
      return a.isRunning ? -1 : 1;
    }
    return b.lastModified.getTime() - a.lastModified.getTime();
  });

  return results;
}

/**
 * Find the JSONL file path for a session, trying the primary slug
 * and falling back to broad search.
 */
function findSessionJsonlPath(repoPath: string, sessionId: string): string | undefined {
  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(claudeDir)) {
    return undefined;
  }

  // Primary path
  const primarySlug = repoPathToSlug(repoPath);
  const primaryFile = path.join(claudeDir, primarySlug, `${sessionId}.jsonl`);
  if (fs.existsSync(primaryFile)) {
    return primaryFile;
  }

  // Broad search fallback
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
