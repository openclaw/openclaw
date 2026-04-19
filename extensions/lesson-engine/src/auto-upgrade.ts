import * as fs from "node:fs";
import { upgradeSeverityOneStep } from "./hit.js";
import type { AgentName, ErrorSeed, LessonsFile, Severity } from "./types.js";
import { atomicWriteJson, lessonsFilePath, readJson } from "./utils.js";

// ── Constants ──

/** Minimum distinct error fingerprints sharing a tag to trigger a severity bump. */
const AUTO_UPGRADE_SEED_THRESHOLD = 3;

/** How many days back to look when counting error seeds. */
const SEED_LOOKBACK_DAYS = 30;

// ── Types ──

export interface AutoUpgradeEntry {
  lessonId: string;
  title: string;
  before: Severity;
  after: Severity;
  matchingFingerprints: number;
}

export interface AutoUpgradeResult {
  agent: AgentName;
  upgrades: AutoUpgradeEntry[];
  dryRun: boolean;
}

// ── Main ──

/**
 * Scan persisted error seeds and upgrade lesson severity when a lesson's tags
 * have been "hit" by ≥ AUTO_UPGRADE_SEED_THRESHOLD distinct error fingerprints
 * in the last SEED_LOOKBACK_DAYS days.
 *
 * Only upgrades one step at a time (minor→important→high→critical).
 * Never downgrades. Skips lessons already at "critical".
 */
export function autoUpgradeLessons(opts: {
  agent: AgentName;
  seeds: ErrorSeed[];
  root?: string;
  dryRun?: boolean;
  now?: Date;
}): AutoUpgradeResult {
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - SEED_LOOKBACK_DAYS * 86_400_000).toISOString();

  // Filter to this agent's recent seeds only
  const recentSeeds = opts.seeds.filter((s) => s.agent === opts.agent && s.timestamp >= cutoff);

  const filePath = lessonsFilePath(opts.agent, opts.root);
  if (!fs.existsSync(filePath)) {
    return { agent: opts.agent, upgrades: [], dryRun };
  }

  const file = readJson<LessonsFile>(filePath);
  const lessons = (Array.isArray(file.lessons) ? file.lessons : []).slice();

  const upgrades: AutoUpgradeEntry[] = [];
  let mutated = false;

  for (let i = 0; i < lessons.length; i++) {
    const lesson = lessons[i];
    if (lesson.lifecycle !== "active") continue;
    if (lesson.severity === "critical") continue;

    const lessonTags = new Set<string>(Array.isArray(lesson.tags) ? lesson.tags : []);
    if (lessonTags.size === 0) continue;

    // Count distinct error fingerprints whose domainTags overlap lesson.tags
    const matchingFingerprints = new Set<string>();
    for (const seed of recentSeeds) {
      const overlap = seed.domainTags.some((dt) => lessonTags.has(dt));
      if (overlap) matchingFingerprints.add(seed.fingerprint);
    }

    if (matchingFingerprints.size >= AUTO_UPGRADE_SEED_THRESHOLD) {
      const before = lesson.severity;
      const after = upgradeSeverityOneStep(before);
      if (after !== before) {
        lessons[i] = { ...lesson, severity: after };
        upgrades.push({
          lessonId: lesson.id,
          title: lesson.title ?? lesson.id,
          before,
          after,
          matchingFingerprints: matchingFingerprints.size,
        });
        mutated = true;
      }
    }
  }

  if (!dryRun && mutated) {
    atomicWriteJson(filePath, { ...file, lessons });
  }

  return { agent: opts.agent, upgrades, dryRun };
}
