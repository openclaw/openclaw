import * as fs from "node:fs";
import type { Lesson, LessonsFile, RawLesson, RawLessonsFile, Severity } from "./types.js";
import { atomicWriteJson, jsonClone, nowIso, readLessonsFile, writeBackup } from "./utils.js";

const VALID_SEVERITIES = new Set<Severity>(["critical", "high", "important", "minor"]);
const VALID_LIFECYCLES = new Set(["active", "stale", "archive"]);

function normalizeSeverity(input: unknown): Severity {
  if (typeof input === "string" && VALID_SEVERITIES.has(input as Severity)) {
    return input as Severity;
  }
  return "important";
}

function normalizeCreatedAt(raw: RawLesson, fallbackIso: string): string {
  const existing = raw.createdAt;
  if (typeof existing === "string" && existing.length > 0) return existing;
  return fallbackIso;
}

export interface MigrateDiffEntry {
  id: string;
  addedFields: string[];
  repairedFields: string[];
}

export interface MigrateResult {
  agent: string;
  filePath: string;
  totalLessons: number;
  mutatedCount: number;
  diff: MigrateDiffEntry[];
  backupPath?: string;
  dryRun: boolean;
  wrote: boolean;
  alreadyMigrated: boolean;
}

/** Pure migration: produce a migrated file structure alongside a per-lesson diff. */
export function migrateData(
  raw: RawLessonsFile,
  opts: { now?: Date } = {},
): { migrated: LessonsFile; diff: MigrateDiffEntry[] } {
  const now = opts.now ?? new Date();
  const fallbackIso = nowIso(now);
  const diff: MigrateDiffEntry[] = [];

  const cloned = jsonClone(raw) as RawLessonsFile;
  const rawLessons = Array.isArray(cloned.lessons) ? cloned.lessons : [];
  const migratedLessons: Lesson[] = rawLessons.map((orig) => {
    const added: string[] = [];
    const repaired: string[] = [];
    const lesson = { ...(orig as Record<string, unknown>) } as Record<string, unknown>;

    const addIfMissing = (key: string, value: unknown) => {
      if (!(key in lesson)) {
        lesson[key] = value;
        added.push(key);
      }
    };

    addIfMissing("createdAt", normalizeCreatedAt(orig, fallbackIso));

    if (!("severity" in lesson)) {
      lesson.severity = normalizeSeverity(undefined);
      added.push("severity");
    } else if (!VALID_SEVERITIES.has(lesson.severity as Severity)) {
      lesson.severity = normalizeSeverity(lesson.severity);
      repaired.push("severity");
    }

    addIfMissing("hitCount", 0);
    addIfMissing("appliedCount", 0);
    addIfMissing("lastHitAt", null);
    addIfMissing("mergedFrom", []);
    addIfMissing("duplicateOf", null);

    if (!("lifecycle" in lesson)) {
      lesson.lifecycle = "active";
      added.push("lifecycle");
    } else if (!VALID_LIFECYCLES.has(lesson.lifecycle as string)) {
      lesson.lifecycle = "active";
      repaired.push("lifecycle");
    }

    if (added.length > 0 || repaired.length > 0) {
      diff.push({
        id: String(lesson.id),
        addedFields: added,
        repairedFields: repaired,
      });
    }

    return lesson as unknown as Lesson;
  });

  const migrated: LessonsFile = {
    ...(cloned as Record<string, unknown>),
    version: typeof cloned.version === "number" ? cloned.version : 1,
    lessons: migratedLessons,
  } as LessonsFile;

  return { migrated, diff };
}

export interface MigrateOptions {
  filePath: string;
  agent: string;
  dryRun: boolean;
  now?: Date;
}

/** Run migration against a file. Writes `<path>.bak.<ts>` backup before atomic rewrite. */
export function migrateFile(opts: MigrateOptions): MigrateResult {
  const { filePath, agent, dryRun, now } = opts;

  if (!fs.existsSync(filePath)) {
    return {
      agent,
      filePath,
      totalLessons: 0,
      mutatedCount: 0,
      diff: [],
      dryRun,
      wrote: false,
      alreadyMigrated: false,
    };
  }

  const raw = readLessonsFile(filePath);
  const total = Array.isArray(raw.lessons) ? raw.lessons.length : 0;
  const { migrated, diff } = migrateData(raw, { now });
  const mutated = diff.length;
  const alreadyMigrated = mutated === 0;

  let backupPath: string | undefined;
  let wrote = false;
  if (!dryRun && !alreadyMigrated) {
    backupPath = writeBackup(filePath, raw, now);
    atomicWriteJson(filePath, migrated);
    wrote = true;
  }

  return {
    agent,
    filePath,
    totalLessons: total,
    mutatedCount: mutated,
    diff,
    backupPath,
    dryRun,
    wrote,
    alreadyMigrated,
  };
}
