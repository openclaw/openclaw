import fs from "node:fs/promises";
import path from "node:path";
import { createSnapshot, rotateSnapshots } from "./snapshot.js";
import {
  isAgentCreated,
  loadUsage,
  setCreatedBy,
  setLastRunAt,
  setPaused,
  setPinned,
  setState,
  shouldRunCurator,
  type UsageEntry,
  type UsageFile,
} from "./telemetry.js";
import {
  determineAllTransitions,
  determineTransition,
  type TransitionResult,
  type TransitionThresholds,
} from "./transitions.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type { CuratorConfig } from "./config.js";
export { resolveConfig } from "./config.js";
import type { CuratorConfig } from "./config.js";

export interface RunDecision {
  shouldRun: boolean;
  reason: string;
  firstRun: boolean;
}

export interface CuratorRunResult {
  timestamp: string;
  snapshotPath: string | null;
  transitions: Array<{
    name: string;
    action: string;
    newState: string;
    daysSinceUsed: number;
  }>;
  mutations: Array<{
    name: string;
    action: "mark_stale" | "archive";
    oldState: string;
    newState: string;
  }>;
  dryRun: boolean;
  error?: string;
}

// ── Lockfile ────────────────────────────────────────────────────────────────

function lockfilePath(workspaceDir: string): string {
  return path.join(workspaceDir, "skills", ".curator_backups", ".in-progress");
}

async function acquireLock(workspaceDir: string): Promise<boolean> {
  const lp = lockfilePath(workspaceDir);
  await fs.mkdir(path.dirname(lp), { recursive: true });
  try {
    await fs.writeFile(lp, `${process.pid}\n${Date.now()}\n`, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(workspaceDir: string): Promise<void> {
  const lp = lockfilePath(workspaceDir);
  try {
    await fs.unlink(lp);
  } catch {
    // ignore
  }
}

// ── Helper: archive dir ─────────────────────────────────────────────────────

function archiveDir(workspaceDir: string): string {
  return path.join(workspaceDir, "skills", ".archive");
}

async function moveSkillToArchive(workspaceDir: string, skillName: string): Promise<void> {
  const skillsDir = path.join(workspaceDir, "skills");
  const srcDir = path.join(skillsDir, skillName);
  const dstDir = path.join(archiveDir(workspaceDir), skillName);

  // Check source exists
  try {
    await fs.access(srcDir);
  } catch {
    // Source doesn't exist (maybe already moved or never created)
    return;
  }

  await fs.mkdir(path.dirname(dstDir), { recursive: true });
  await fs.rename(srcDir, dstDir);
}

async function restoreSkillFromArchive(workspaceDir: string, skillName: string): Promise<void> {
  const skillsDir = path.join(workspaceDir, "skills");
  const srcDir = path.join(archiveDir(workspaceDir), skillName);
  const dstDir = path.join(skillsDir, skillName);

  await fs.mkdir(path.dirname(dstDir), { recursive: true });
  await fs.rename(srcDir, dstDir);
}

// ── Decision ────────────────────────────────────────────────────────────────

export function decideRun(params: {
  usage: UsageFile;
  config: CuratorConfig;
  now: Date;
}): RunDecision {
  const { usage, config, now } = params;

  if (!config.enabled) {
    return { shouldRun: false, reason: "curator disabled", firstRun: false };
  }

  if (usage.paused) {
    return { shouldRun: false, reason: "curator paused", firstRun: false };
  }

  const decision = shouldRunCurator({
    lastRunAt: usage.last_run_at,
    intervalHours: config.interval_hours,
    now,
  });

  if (usage.last_run_at === null) {
    return { shouldRun: false, reason: decision.reason, firstRun: true };
  }

  return { shouldRun: decision.shouldRun, reason: decision.reason, firstRun: false };
}

// ── Run ─────────────────────────────────────────────────────────────────────

export async function curatorRun(params: {
  workspaceDir: string;
  config: CuratorConfig;
  dryRun?: boolean;
  now?: Date;
}): Promise<CuratorRunResult> {
  const now = params.now ?? new Date();
  const timestamp = now.toISOString();
  const thresholds: TransitionThresholds = {
    stale_after_days: params.config.stale_after_days,
    archive_after_days: params.config.archive_after_days,
  };

  const result: CuratorRunResult = {
    timestamp,
    snapshotPath: null,
    transitions: [],
    mutations: [],
    dryRun: params.dryRun ?? false,
  };

  // Load usage
  const usage = await loadUsage(params.workspaceDir);

  // Check if we should run
  const decision = decideRun({ usage, config: params.config, now });
  if (!decision.shouldRun && !decision.firstRun) {
    return { ...result, error: decision.reason };
  }

  // First-run defer: seed last_run_at and exit
  if (usage.last_run_at === null) {
    await setLastRunAt(params.workspaceDir, timestamp);
    return { ...result, error: "first-run: seeded last_run_at, skipping" };
  }

  // Acquire lock
  if (!params.dryRun) {
    const locked = await acquireLock(params.workspaceDir);
    if (!locked) {
      return { ...result, error: "lockfile exists: another curator run may be in progress" };
    }
  }

  try {
    // Phase A: determine transitions (only agent-created, non-pinned, non-bundled, non-hub)
    const transitions = determineAllTransitions(usage.skills, thresholds, now);

    result.transitions = transitions.map((t) => ({
      name: t.name,
      action: t.result.action,
      newState: t.result.newState,
      daysSinceUsed: t.result.daysSinceUsed,
    }));

    // Snapshot before mutations
    if (params.config.backup.enabled && !params.dryRun && transitions.length > 0) {
      try {
        const snap = await createSnapshot(params.workspaceDir);
        result.snapshotPath = snap.archivePath;
        await rotateSnapshots(params.workspaceDir, params.config.backup.keep);
      } catch (err) {
        result.error = `snapshot failed: ${err instanceof Error ? err.message : String(err)}`;
        return result;
      }
    }

    // Apply mutations
    for (const { name, result: transResult } of transitions) {
      if (transResult.action === "none") continue;

      if (!params.dryRun) {
        // Update state in .usage.json
        await setState(params.workspaceDir, name, transResult.newState);

        // If archiving, move to .archive/
        if (transResult.action === "archive") {
          await moveSkillToArchive(params.workspaceDir, name);
        }
      }

      result.mutations.push({
        name,
        action: transResult.action as "mark_stale" | "archive",
        oldState: usage.skills[name]?.state ?? "unknown",
        newState: transResult.newState,
      });
    }

    // Update last_run_at
    if (!params.dryRun) {
      await setLastRunAt(params.workspaceDir, timestamp);
    }

    return result;
  } finally {
    if (!params.dryRun) {
      await releaseLock(params.workspaceDir);
    }
  }
}

/** Pause the curator (persisted). */
export async function pauseCurator(workspaceDir: string): Promise<void> {
  await setPaused(workspaceDir, true);
}

/** Resume the curator (persisted). */
export async function resumeCurator(workspaceDir: string): Promise<void> {
  await setPaused(workspaceDir, false);
}

/** Pin a skill — immune to transitions and deletion. */
export async function pinSkill(workspaceDir: string, name: string): Promise<UsageEntry> {
  return setPinned(workspaceDir, name, true);
}

/** Unpin a skill — it becomes eligible for transitions again. */
export async function unpinSkill(workspaceDir: string, name: string): Promise<UsageEntry> {
  return setPinned(workspaceDir, name, false);
}

/** Restore a skill from .archive/ back to skills/ */
export async function restoreSkill(workspaceDir: string, name: string): Promise<void> {
  await restoreSkillFromArchive(workspaceDir, name);
  // Mark as active again
  await setState(workspaceDir, name, "active");
}

/** Adopt a skill: mark as agent-created so the curator manages it. */
export async function adoptSkill(workspaceDir: string, name: string): Promise<UsageEntry> {
  return setCreatedBy(workspaceDir, name, "agent");
}

/** Disown a skill: mark as user-created so the curator leaves it alone. */
export async function disownSkill(workspaceDir: string, name: string): Promise<UsageEntry> {
  return setCreatedBy(workspaceDir, name, "user");
}

// ── Phase B: LLM Review Pass ───────────────────────────────────────────────
//
// NOTE: Phase B requires a model-calling function (e.g. gateway-level
// auxiliary.curator model slot). Without it, only Phase A (deterministic
// transitions) runs. The LLM review is optional and additive — it never
// blocks Phase A.

/**
 * Run the LLM review pass (Phase B).
 *
 * Requires a `callModel` function that takes a system prompt and user
 * prompt string, and returns the model's text response.
 *
 * Returns parsed and validated review decisions, or null if the call
 * fails or returns unparseable output.
 */
export async function curatorRunReview(params: {
  workspaceDir: string;
  callModel: (systemPrompt: string, userPrompt: string) => Promise<string>;
}): Promise<{
  decisions: import("./reviewer.js").ReviewAction[];
  manifest: import("./reviewer.js").ReviewManifest;
} | null> {
  const { buildReviewManifest, parseReviewResponse } = await import("./reviewer.js");
  const { loadUsage, setState } = await import("./telemetry.js");

  const manifest = await buildReviewManifest(params.workspaceDir);
  if (manifest.skills.length === 0) {
    return { decisions: [], manifest };
  }

  // Build user prompt: list skill names and descriptions
  const skillList = manifest.skills.map((s, i) => `${i}. ${s.name} — ${s.description}`).join("\n");
  const userPrompt = `Review these skills and return decisions:\n\n${skillList}`;

  try {
    const raw = await params.callModel(
      (await import("./reviewer.js")).CURATOR_SYSTEM_PROMPT,
      userPrompt,
    );
    const response = parseReviewResponse(raw);
    return { decisions: response.decisions, manifest };
  } catch {
    return null; // Model call or parse failure — non-blocking
  }
}
