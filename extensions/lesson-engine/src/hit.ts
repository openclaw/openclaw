import * as fs from "node:fs";
import type { AgentName, LessonsFile, Severity } from "./types.js";
import { atomicWriteJson, lessonsFilePath, nowIso, readJson } from "./utils.js";

// ── Severity ordering (lower index = more severe) ──

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  important: 2,
  minor: 3,
};

/** One-step severity upgrade: minor→important→high→critical */
export function upgradeSeverityOneStep(s: Severity): Severity {
  switch (s) {
    case "minor":
      return "important";
    case "important":
      return "high";
    case "high":
      return "critical";
    case "critical":
      return "critical";
  }
}

/** Determine minimum target severity from hitCount thresholds.
 *  hitCount >= 4 → critical
 *  hitCount >= 2 → high
 *  otherwise    → no change
 */
function thresholdSeverity(hitCount: number): Severity | null {
  if (hitCount >= 4) return "critical";
  if (hitCount >= 2) return "high";
  return null;
}

// ── Types ──

export interface HitOptions {
  agent: AgentName;
  lessonId: string;
  root?: string;
  dryRun?: boolean;
  now?: Date;
}

export interface HitResult {
  agent: AgentName;
  lessonId: string;
  found: boolean;
  hitCount: number;
  severityBefore: Severity | null;
  severityAfter: Severity | null;
  upgraded: boolean;
  dryRun: boolean;
}

// ── Main ──

/**
 * Increment hitCount for a lesson and optionally auto-upgrade its severity.
 *
 * Auto-upgrade thresholds (applied only when new severity > current):
 *   hitCount >= 2 → at least "high"
 *   hitCount >= 4 → "critical"
 */
export function hitLesson(opts: HitOptions): HitResult {
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? new Date();
  const filePath = lessonsFilePath(opts.agent, opts.root);

  const notFound: HitResult = {
    agent: opts.agent,
    lessonId: opts.lessonId,
    found: false,
    hitCount: 0,
    severityBefore: null,
    severityAfter: null,
    upgraded: false,
    dryRun,
  };

  if (!fs.existsSync(filePath)) return notFound;

  const file = readJson<LessonsFile>(filePath);
  const lessons = Array.isArray(file.lessons) ? file.lessons : [];
  const idx = lessons.findIndex((l) => l.id === opts.lessonId);

  if (idx === -1) return notFound;

  const lesson = { ...lessons[idx] };
  const severityBefore = lesson.severity;

  lesson.hitCount = (lesson.hitCount ?? 0) + 1;
  lesson.lastHitAt = nowIso(now);

  // Auto-upgrade severity when hitCount reaches thresholds
  const target = thresholdSeverity(lesson.hitCount);
  let upgraded = false;
  if (target !== null && SEVERITY_ORDER[lesson.severity] > SEVERITY_ORDER[target]) {
    lesson.severity = target;
    upgraded = true;
  }

  const severityAfter = lesson.severity;

  if (!dryRun) {
    const updated: LessonsFile = {
      ...file,
      lessons: lessons.map((l, i) => (i === idx ? lesson : l)),
    };
    atomicWriteJson(filePath, updated);
  }

  return {
    agent: opts.agent,
    lessonId: opts.lessonId,
    found: true,
    hitCount: lesson.hitCount,
    severityBefore,
    severityAfter,
    upgraded,
    dryRun,
  };
}
