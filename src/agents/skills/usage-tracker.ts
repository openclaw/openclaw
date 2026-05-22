/**
 * Skill Usage Telemetry — Real-time tracking module.
 *
 * Tracks exec-tool invocations that match a loaded skill's CLI binaries,
 * writing incrementally to a per-agent skill-usage.json file.
 *
 * Data format (per THINKING.md §3.3):
 *   ~/.openclaw/agents/{agentId}/skill-usage.json
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSubsystemLogger } from "../logging/subsystem.js";

const trackerLogger = createSubsystemLogger("skill-usage");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillInvocationRecord {
  timestamp: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  sessionKey: string;
}

export interface SkillUsageEntry {
  lastUsed: string;
  totalInvocations: number;
  invocations: SkillInvocationRecord[];
}

export interface SkillUsageFile {
  version: 1;
  skills: Record<string, SkillUsageEntry>;
}

export interface TrackSkillUsageParams {
  agentId: string;
  skillName: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  sessionKey: string;
}

// ---------------------------------------------------------------------------
// File path resolution
// ---------------------------------------------------------------------------

const STATE_DIR = (() => {
  const env = process.env;
  if (env.OPENCLAW_STATE_DIR) return env.OPENCLAW_STATE_DIR;
  if (env.CLAWDBOT_STATE_DIR) return env.CLAWDBOT_STATE_DIR;
  const xdg = env.XDG_STATE_HOME;
  if (xdg) return path.join(xdg, "openclaw");
  return path.join(os.homedir(), ".openclaw");
})();

function resolveUsageFilePath(agentId: string): string {
  return path.join(STATE_DIR, "agents", agentId, "skill-usage.json");
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

/** In-memory cache to avoid re-reading the JSON file on every exec. */
const usageCache = new Map<string, SkillUsageFile>();

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadUsageFile(agentId: string): SkillUsageFile {
  const cached = usageCache.get(agentId);
  if (cached) return cached;

  const filePath = resolveUsageFilePath(agentId);
  let data: SkillUsageFile = { version: 1, skills: {} };
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as SkillUsageFile;
        // ensure version field
        if (data.version === undefined) data.version = 1;
        if (!data.skills) data.skills = {};
      }
    }
  } catch (err) {
    trackerLogger.warn(
      `Failed to load skill-usage.json for agent "${agentId}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  usageCache.set(agentId, data);
  return data;
}

function saveUsageFile(agentId: string, data: SkillUsageFile): void {
  const filePath = resolveUsageFilePath(agentId);
  usageCache.set(agentId, data);
  try {
    ensureDir(filePath);
    // Atomic write: write to temp file then rename
    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: "utf-8", flag: "w" });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    trackerLogger.warn(
      `Failed to save skill-usage.json for agent "${agentId}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a skill invocation.  Called from the exec-tool execution path.
 * Updates the in-memory cache and writes to disk asynchronously (fire-and-forget).
 */
export function trackSkillUsage(params: TrackSkillUsageParams): void {
  const { agentId, skillName, command, exitCode, durationMs, sessionKey } = params;

  if (!agentId || !skillName) return;

  const data = loadUsageFile(agentId);
  const now = new Date().toISOString();
  const entry = data.skills[skillName] ?? {
    lastUsed: now,
    totalInvocations: 0,
    invocations: [],
  };

  const record: SkillInvocationRecord = {
    timestamp: now,
    command,
    exitCode,
    durationMs,
    sessionKey,
  };

  entry.lastUsed = now;
  entry.totalInvocations += 1;
  entry.invocations.push(record);

  // Keep at most 1000 invocation records to bound file size
  if (entry.invocations.length > 1000) {
    entry.invocations = entry.invocations.slice(-1000);
  }

  data.skills[skillName] = entry;
  saveUsageFile(agentId, data);

  trackerLogger.debug(
    `Tracked skill usage: skill=${skillName} agent=${agentId} command="${command}" exitCode=${exitCode}`,
  );
}

/**
 * Read the full skill usage data for an agent.
 */
export function getSkillUsage(agentId: string): SkillUsageFile {
  return loadUsageFile(agentId);
}

/**
 * Clear the in-memory cache for a given agent (useful for testing).
 */
export function clearUsageCache(agentId?: string): void {
  if (agentId) {
    usageCache.delete(agentId);
  } else {
    usageCache.clear();
  }
}
