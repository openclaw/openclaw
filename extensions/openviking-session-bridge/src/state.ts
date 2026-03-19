import fs from "node:fs";
import path from "node:path";
import type { SessionCheckpoint } from "./types.js";

function checkpointPath(stateDir: string, sessionId: string): string {
  // Sanitize sessionId to prevent path traversal (UUIDs only in practice).
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  return path.join(stateDir, `${safe}.json`);
}

function ensureStateDir(stateDir: string): void {
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
}

export function loadCheckpoint(stateDir: string, sessionId: string): SessionCheckpoint | null {
  const p = checkpointPath(stateDir, sessionId);
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as SessionCheckpoint;
    if (parsed.openclawSessionId !== sessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCheckpoint(stateDir: string, checkpoint: SessionCheckpoint): void {
  ensureStateDir(stateDir);
  const p = checkpointPath(stateDir, checkpoint.openclawSessionId);
  // Atomic write: write to temp file, then rename.
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(checkpoint, null, 2), "utf-8");
  fs.renameSync(tmp, p);
}

/**
 * Mark a checkpoint as finalized (committed to OV; no further flushing needed).
 * No-op if the checkpoint doesn't exist.
 */
export function markFinalized(stateDir: string, sessionId: string): void {
  const existing = loadCheckpoint(stateDir, sessionId);
  if (!existing) return;
  saveCheckpoint(stateDir, { ...existing, finalized: true, updatedAt: new Date().toISOString() });
}

/**
 * Return all non-finalized checkpoints found in stateDir.
 *
 * Used at plugin startup to replay sessions that were interrupted before
 * session_end fired or before the flush completed (e.g. process killed).
 * Corrupted or unreadable checkpoint files are silently skipped.
 */
export function listPendingCheckpoints(stateDir: string): SessionCheckpoint[] {
  try {
    if (!fs.existsSync(stateDir)) return [];
    const entries = fs.readdirSync(stateDir);
    const pending: SessionCheckpoint[] = [];
    for (const file of entries) {
      // Only process our checkpoint files; ignore tmp files from in-progress writes.
      if (!file.endsWith(".json") || file.includes(".tmp.")) continue;
      const p = path.join(stateDir, file);
      try {
        const raw = fs.readFileSync(p, "utf-8");
        const cp = JSON.parse(raw) as unknown;
        if (
          cp &&
          typeof cp === "object" &&
          !Array.isArray(cp) &&
          typeof (cp as Record<string, unknown>).openclawSessionId === "string" &&
          (cp as Record<string, unknown>).finalized === false
        ) {
          pending.push(cp as SessionCheckpoint);
        }
      } catch {
        // Skip corrupted entries.
      }
    }
    return pending;
  } catch {
    return [];
  }
}
