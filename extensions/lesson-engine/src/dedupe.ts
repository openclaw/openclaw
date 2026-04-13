import * as fs from "node:fs";
import { cosine, documentFrequency, tfidfVector, tokenize } from "./tfidf.js";
import type { Lesson, LessonsFile, Severity } from "./types.js";
import { atomicWriteJson, jsonClone, nowIso, readJson } from "./utils.js";

/** cosine >= this ⇒ duplicate */
export const DEDUPE_THRESHOLD = 0.6;

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  important: 2,
  minor: 1,
};

/** Build the text used for TF-IDF — title + tags + (category * 2). */
export function lessonDocument(lesson: Lesson): string {
  const title = typeof lesson.title === "string" ? lesson.title : "";
  const tags = Array.isArray(lesson.tags) ? lesson.tags.join(" ") : "";
  const category = typeof lesson.category === "string" ? lesson.category : "";
  return `${title} ${tags} ${category} ${category}`;
}

export interface DedupeMerge {
  keepId: string;
  mergedId: string;
  similarity: number;
  tagsBefore: string[];
  tagsAfter: string[];
}

export interface DedupeResult {
  agent: string;
  filePath: string;
  totalLessons: number;
  activeBefore: number;
  activeAfter: number;
  merges: DedupeMerge[];
  dryRun: boolean;
  wrote: boolean;
}

function preferKeep(a: Lesson, b: Lesson): { keep: Lesson; merge: Lesson } {
  const ra = SEVERITY_RANK[a.severity] ?? 0;
  const rb = SEVERITY_RANK[b.severity] ?? 0;
  if (ra !== rb) return ra > rb ? { keep: a, merge: b } : { keep: b, merge: a };

  const ha = a.hitCount ?? 0;
  const hb = b.hitCount ?? 0;
  if (ha !== hb) return ha > hb ? { keep: a, merge: b } : { keep: b, merge: a };

  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  const taS = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY;
  const tbS = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY;
  if (taS !== tbS) return taS <= tbS ? { keep: a, merge: b } : { keep: b, merge: a };

  // final tie-break by id to stay deterministic
  return a.id <= b.id ? { keep: a, merge: b } : { keep: b, merge: a };
}

function unionTags(a: string[] | undefined, b: string[] | undefined): string[] {
  const set = new Set<string>();
  for (const t of a ?? []) set.add(t);
  for (const t of b ?? []) set.add(t);
  return Array.from(set).sort((left, right) => left.localeCompare(right));
}

/**
 * Pure dedupe pass over a migrated LessonsFile. Returns a new file + the merge log.
 * Only `lifecycle === "active"` lessons participate. Lessons outside that set are left untouched.
 */
export function dedupeData(
  file: LessonsFile,
  opts: { threshold?: number; now?: Date } = {},
): { next: LessonsFile; merges: DedupeMerge[] } {
  const threshold = opts.threshold ?? DEDUPE_THRESHOLD;
  const now = opts.now ?? new Date();
  const timestamp = nowIso(now);

  const next = jsonClone(file);
  const lessons = next.lessons;
  const byId = new Map<string, Lesson>();
  for (const l of lessons) byId.set(l.id, l);

  // Index of active lesson ids → tokenized doc
  const activeIds: string[] = [];
  const tokens: string[][] = [];
  for (const l of lessons) {
    if (l.lifecycle === "active") {
      activeIds.push(l.id);
      tokens.push(tokenize(lessonDocument(l)));
    }
  }

  const df = documentFrequency(tokens);
  const vectors = tokens.map((toks) => tfidfVector(toks, df, tokens.length));

  const merges: DedupeMerge[] = [];
  // Track lessons that have been merged away in this pass so we don't double-merge.
  const mergedAway = new Set<string>();

  for (let i = 0; i < activeIds.length; i++) {
    const idA = activeIds[i];
    if (mergedAway.has(idA)) continue;
    for (let j = i + 1; j < activeIds.length; j++) {
      const idB = activeIds[j];
      if (mergedAway.has(idB)) continue;
      const sim = cosine(vectors[i], vectors[j]);
      if (sim < threshold) continue;

      const a = byId.get(idA);
      const b = byId.get(idB);
      if (!a || !b) continue;
      if (a.lifecycle !== "active" || b.lifecycle !== "active") continue;

      const { keep, merge } = preferKeep(a, b);
      const tagsBefore = Array.isArray(keep.tags) ? [...keep.tags] : [];
      const tagsAfter = unionTags(keep.tags, merge.tags);
      keep.tags = tagsAfter;
      keep.mergedFrom = Array.isArray(keep.mergedFrom)
        ? Array.from(new Set([...keep.mergedFrom, merge.id]))
        : [merge.id];
      merge.lifecycle = "archive";
      merge.duplicateOf = keep.id;
      merge.lastHitAt = merge.lastHitAt ?? null;
      // Stamp the archive time on the merged lesson to make the audit trail explicit.
      (merge as Record<string, unknown>).archivedAt = timestamp;
      mergedAway.add(merge.id);
      merges.push({
        keepId: keep.id,
        mergedId: merge.id,
        similarity: sim,
        tagsBefore,
        tagsAfter,
      });
    }
  }

  return { next, merges };
}

export interface DedupeOptions {
  filePath: string;
  agent: string;
  dryRun: boolean;
  threshold?: number;
  now?: Date;
}

export function dedupeFile(opts: DedupeOptions): DedupeResult {
  const { filePath, agent, dryRun, threshold, now } = opts;

  if (!fs.existsSync(filePath)) {
    return {
      agent,
      filePath,
      totalLessons: 0,
      activeBefore: 0,
      activeAfter: 0,
      merges: [],
      dryRun,
      wrote: false,
    };
  }

  const file = readJson<LessonsFile>(filePath);
  const activeBefore = (file.lessons ?? []).filter((l) => l.lifecycle === "active").length;
  const { next, merges } = dedupeData(file, { threshold, now });
  const activeAfter = next.lessons.filter((l) => l.lifecycle === "active").length;

  let wrote = false;
  if (!dryRun && merges.length > 0) {
    atomicWriteJson(filePath, next);
    wrote = true;
  }

  return {
    agent,
    filePath,
    totalLessons: next.lessons.length,
    activeBefore,
    activeAfter,
    merges,
    dryRun,
    wrote,
  };
}
