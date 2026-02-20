/**
 * Shared live-session state for Claude Code spawn mode.
 *
 * This module holds the in-memory maps for active spawns and live sessions,
 * plus lightweight query/kill functions. It's kept separate from runner.ts
 * so that CLI modules (cc-cli) can inspect state without pulling in the
 * heavy spawn machinery (mcp-bridge, protocol, subsystem logger).
 */

import type { ChildProcess } from "node:child_process";
import path from "node:path";
import type { ClaudeCodeResult, ClaudeCodeSpawnOptions } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type LiveSession = {
  child: ChildProcess;
  sessionId: string | undefined;
  repoPath: string;
  startedAt: number;
  accumulatedCostUsd: number;
  accumulatedTurns: number;
  lastToolName: string | undefined;
  lastActivityText: string;
  /** Persistent spawn fields. */
  results: ClaudeCodeResult[];
  persistent: boolean;
  pendingFollowUp: { resolve: (r: ClaudeCodeResult) => void; reject: (e: Error) => void } | null;
  persistentIdleTimer: ReturnType<typeof setTimeout> | null;
};

export type RepoQueueEntry = {
  resolve: (value: ClaudeCodeResult) => void;
  reject: (reason: unknown) => void;
  options: ClaudeCodeSpawnOptions;
};

// ── State ────────────────────────────────────────────────────────────────────

/** Active child processes keyed by resolved repo path. */
export const activeSpawns = new Map<string, ChildProcess>();
export const queuedSpawns = new Map<string, RepoQueueEntry>();
export const liveSessions = new Map<string, LiveSession>();

// ── Query/Kill ───────────────────────────────────────────────────────────────

/**
 * Kill a running Claude Code session for a repo.
 */
export function killClaudeCode(repoPath: string): boolean {
  const resolved = path.resolve(repoPath);
  const child = activeSpawns.get(resolved);
  if (!child) {
    return false;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }, 5_000);
  activeSpawns.delete(resolved);
  liveSessions.delete(resolved);
  return true;
}

/**
 * Check if a Claude Code session is running for a repo.
 */
export function isClaudeCodeRunning(repoPath: string): boolean {
  return activeSpawns.has(path.resolve(repoPath));
}

/**
 * Get the live session for a repo (if running).
 */
export function getLiveSession(repoPath: string): LiveSession | undefined {
  return liveSessions.get(path.resolve(repoPath));
}

/**
 * Get all live sessions.
 */
export function getAllLiveSessions(): Map<string, LiveSession> {
  return liveSessions;
}

/**
 * Kill ALL running Claude Code sessions.
 * Used during gateway shutdown/restart to prevent orphaned child processes.
 * Returns the number of sessions killed.
 */
export function killAllClaudeCode(): number {
  let killed = 0;
  for (const [repoPath, child] of activeSpawns) {
    try {
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        } catch {
          // ignore — process may have already exited
        }
      }, 5_000);
      killed++;
    } catch {
      // ignore — process may have already exited
    }
    liveSessions.delete(repoPath);
  }
  activeSpawns.clear();
  // Reject any queued spawns
  for (const [, entry] of queuedSpawns) {
    try {
      entry.reject(new Error("Gateway shutting down"));
    } catch {
      // ignore
    }
  }
  queuedSpawns.clear();
  return killed;
}
