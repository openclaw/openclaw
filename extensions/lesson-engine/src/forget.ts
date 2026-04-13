import * as fs from "node:fs";
import type { Lesson, LessonsFile, Severity } from "./types.js";
import { atomicWriteJson, daysBetween, jsonClone, nowIso, readJson } from "./utils.js";

export const DEFAULT_MAX_ACTIVE = 50;
export const STALE_DAYS = 90;

const SEVERITY_SCORE: Record<Severity, number> = {
  critical: 1.0,
  high: 0.75,
  important: 0.5,
  minor: 0.2,
};

export interface ScoreComponents {
  recency: number;
  usefulness: number;
  severity: number;
  total: number;
  daysSinceLastHit: number;
}

/** Compute the 0..1 score for a single lesson at `now`. */
export function scoreLesson(lesson: Lesson, now: Date): ScoreComponents {
  const anchorIso = lesson.lastHitAt ?? lesson.createdAt;
  const days = daysBetween(anchorIso ?? "", now);
  const effectiveDays = Number.isFinite(days) ? Math.max(0, days) : 365 * 10;
  const recency = Math.exp(-effectiveDays / 30);

  const hits = lesson.hitCount ?? 0;
  const applied = lesson.appliedCount ?? 0;
  const usefulness = Math.min(1, (hits + 2 * applied) / 10);

  const severity = SEVERITY_SCORE[lesson.severity] ?? SEVERITY_SCORE.important;

  const total = 0.4 * recency + 0.4 * usefulness + 0.2 * severity;
  return {
    recency,
    usefulness,
    severity,
    total,
    daysSinceLastHit: effectiveDays,
  };
}

export interface ForgetTransition {
  id: string;
  from: Lesson["lifecycle"];
  to: Lesson["lifecycle"];
  score: number;
  daysSinceLastHit: number;
  reason: "cap-exceeded" | "stale-expired";
}

export interface ForgetResult {
  agent: string;
  filePath: string;
  totalLessons: number;
  activeBefore: number;
  activeAfter: number;
  staleAfter: number;
  archiveAfter: number;
  maxActive: number;
  transitions: ForgetTransition[];
  dryRun: boolean;
  wrote: boolean;
}

/** Pure forget pass. Emits a new file + the list of lifecycle transitions. */
export function forgetData(
  file: LessonsFile,
  opts: { maxActive?: number; now?: Date } = {},
): { next: LessonsFile; transitions: ForgetTransition[] } {
  const maxActive = opts.maxActive ?? file.maxActive ?? DEFAULT_MAX_ACTIVE;
  const now = opts.now ?? new Date();
  const timestamp = nowIso(now);
  const next = jsonClone(file);
  const transitions: ForgetTransition[] = [];

  // Step 1: stale → archive if daysSinceLastHit > STALE_DAYS.
  for (const lesson of next.lessons) {
    if (lesson.lifecycle !== "stale") continue;
    const score = scoreLesson(lesson, now);
    if (score.daysSinceLastHit > STALE_DAYS) {
      transitions.push({
        id: lesson.id,
        from: "stale",
        to: "archive",
        score: score.total,
        daysSinceLastHit: score.daysSinceLastHit,
        reason: "stale-expired",
      });
      lesson.lifecycle = "archive";
      (lesson as Record<string, unknown>).archivedAt = timestamp;
    }
  }

  // Step 2: if active > maxActive, demote the lowest-scoring tail to stale.
  const active = next.lessons.filter((l) => l.lifecycle === "active");
  if (active.length > maxActive) {
    const scored = active
      .map((lesson) => ({ lesson, score: scoreLesson(lesson, now) }))
      .sort((a, b) => {
        if (a.score.total !== b.score.total) return a.score.total - b.score.total;
        // tie-break: older createdAt first (more likely to be dropped)
        const ta = Date.parse(a.lesson.createdAt ?? "") || 0;
        const tb = Date.parse(b.lesson.createdAt ?? "") || 0;
        if (ta !== tb) return ta - tb;
        return a.lesson.id.localeCompare(b.lesson.id);
      });
    const toDemote = scored.slice(0, active.length - maxActive);
    for (const { lesson, score } of toDemote) {
      transitions.push({
        id: lesson.id,
        from: "active",
        to: "stale",
        score: score.total,
        daysSinceLastHit: score.daysSinceLastHit,
        reason: "cap-exceeded",
      });
      lesson.lifecycle = "stale";
      (lesson as Record<string, unknown>).staledAt = timestamp;
    }
  }

  return { next, transitions };
}

export interface ForgetOptions {
  filePath: string;
  agent: string;
  dryRun: boolean;
  maxActive?: number;
  now?: Date;
}

export function forgetFile(opts: ForgetOptions): ForgetResult {
  const { filePath, agent, dryRun, maxActive, now } = opts;

  if (!fs.existsSync(filePath)) {
    const effectiveMax = maxActive ?? DEFAULT_MAX_ACTIVE;
    return {
      agent,
      filePath,
      totalLessons: 0,
      activeBefore: 0,
      activeAfter: 0,
      staleAfter: 0,
      archiveAfter: 0,
      maxActive: effectiveMax,
      transitions: [],
      dryRun,
      wrote: false,
    };
  }

  const file = readJson<LessonsFile>(filePath);
  const activeBefore = (file.lessons ?? []).filter((l) => l.lifecycle === "active").length;
  const { next, transitions } = forgetData(file, { maxActive, now });

  const activeAfter = next.lessons.filter((l) => l.lifecycle === "active").length;
  const staleAfter = next.lessons.filter((l) => l.lifecycle === "stale").length;
  const archiveAfter = next.lessons.filter((l) => l.lifecycle === "archive").length;

  let wrote = false;
  if (!dryRun && transitions.length > 0) {
    atomicWriteJson(filePath, next);
    wrote = true;
  }

  return {
    agent,
    filePath,
    totalLessons: next.lessons.length,
    activeBefore,
    activeAfter,
    staleAfter,
    archiveAfter,
    maxActive: maxActive ?? file.maxActive ?? DEFAULT_MAX_ACTIVE,
    transitions,
    dryRun,
    wrote,
  };
}
