import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { DEDUPE_THRESHOLD, lessonDocument } from "./dedupe.js";
import { readCandidatesFile, writeCandidatesFile } from "./distill.js";
import { cosine, documentFrequency, tfidfVector, tokenize } from "./tfidf.js";
import type {
  CandidatesFile,
  GateDecision,
  GateResult,
  Lesson,
  LessonCandidate,
  LessonsFile,
} from "./types.js";
import { atomicWriteJson, jsonClone, lessonsFilePath, nowIso, readJson } from "./utils.js";

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

function candidateDocument(c: LessonCandidate): string {
  const title = c.title ?? "";
  const tags = Array.isArray(c.tags) ? c.tags.join(" ") : "";
  const category = c.category ?? "";
  return `${title} ${tags} ${category} ${category}`;
}

function candidateToLesson(c: LessonCandidate, now: Date): Lesson {
  const createdAt = nowIso(now);
  const hash = crypto.createHash("sha256").update(c.id).digest("hex").slice(0, 8);
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const id = `lesson-${y}${m}${d}-${hash}`;
  return {
    id,
    title: c.title,
    category: c.category,
    tags: [...c.tags],
    context: c.context,
    mistake: c.mistake,
    lesson: c.lesson,
    fix: c.fix,
    createdAt,
    severity: c.severity,
    hitCount: 0,
    appliedCount: 0,
    lastHitAt: null,
    mergedFrom: [],
    duplicateOf: null,
    lifecycle: "active",
    promotedFrom: c.id,
    confidence: c.confidence,
  };
}

export interface GateOptions {
  agents?: string[];
  root?: string;
  confidenceThreshold?: number;
  threshold?: number;
  dryRun?: boolean;
  now?: Date;
  /** Optional override candidates file (skips disk read when provided). */
  candidatesFile?: CandidatesFile;
}

/**
 * Apply gating criteria to pending candidates. When `dryRun` is false, promote
 * passing candidates into the agent's lessons-learned.json and update the
 * candidates file in place.
 */
export function gateCandidates(opts: GateOptions = {}): GateResult {
  const confidenceThreshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const dedupeThreshold = opts.threshold ?? DEDUPE_THRESHOLD;
  const now = opts.now ?? new Date();
  const file = jsonClone(opts.candidatesFile ?? readCandidatesFile(opts.root));
  const decisions: GateDecision[] = [];
  let promoted = 0;
  let rejected = 0;

  // Optionally constrain to a subset of agents.
  const agentFilter = opts.agents ? new Set(opts.agents) : null;

  // Per-agent lessons cache so we only load each file once.
  const lessonsCache = new Map<string, LessonsFile | null>();
  const writeQueue = new Map<string, LessonsFile>();

  for (const candidate of file.candidates) {
    if (candidate.status !== "pending") continue;
    if (agentFilter && !agentFilter.has(candidate.agent)) continue;

    if (candidate.confidence < confidenceThreshold) {
      candidate.status = "rejected";
      decisions.push({
        candidateId: candidate.id,
        action: "rejected",
        reason: "low-confidence",
      });
      rejected++;
      continue;
    }

    const filePath = lessonsFilePath(candidate.agent, opts.root);
    let lessonsFile = lessonsCache.get(candidate.agent);
    if (lessonsFile === undefined) {
      lessonsFile = fs.existsSync(filePath) ? readJson<LessonsFile>(filePath) : null;
      lessonsCache.set(candidate.agent, lessonsFile);
    }

    const activeLessons = (lessonsFile?.lessons ?? []).filter((l) => l.lifecycle === "active");
    // Build TF-IDF over active lessons + candidate so weights are comparable.
    const allDocs = [
      ...activeLessons.map((l) => tokenize(lessonDocument(l))),
      tokenize(candidateDocument(candidate)),
    ];
    const df = documentFrequency(allDocs);
    const vectors = allDocs.map((toks) => tfidfVector(toks, df, allDocs.length));
    const candidateVec = vectors[vectors.length - 1];

    let dupId: string | undefined;
    let dupSim = 0;
    for (let i = 0; i < activeLessons.length; i++) {
      const sim = cosine(candidateVec, vectors[i]);
      if (sim >= dedupeThreshold && sim > dupSim) {
        dupSim = sim;
        dupId = activeLessons[i].id;
      }
    }
    if (dupId) {
      candidate.status = "rejected";
      decisions.push({
        candidateId: candidate.id,
        action: "rejected",
        reason: "duplicate",
        matchingLessonId: dupId,
      });
      rejected++;
      continue;
    }

    // Promote: append to (in-memory) lessons file and stage write.
    const lesson = candidateToLesson(candidate, now);
    candidate.status = "promoted";
    candidate.promotedAt = nowIso(now);
    promoted++;
    decisions.push({
      candidateId: candidate.id,
      action: "promoted",
      reason: "passed",
    });
    const next: LessonsFile = lessonsFile ?? {
      version: 1,
      lessons: [],
    };
    const updated: LessonsFile = {
      ...next,
      lessons: [...(next.lessons ?? []), lesson],
    };
    lessonsCache.set(candidate.agent, updated);
    writeQueue.set(candidate.agent, updated);
  }

  if (!opts.dryRun) {
    for (const [agent, contents] of writeQueue) {
      atomicWriteJson(lessonsFilePath(agent, opts.root), contents);
    }
    if (promoted > 0 || rejected > 0) {
      file.updatedAt = nowIso(now);
      writeCandidatesFile(file, opts.root);
    }
  }

  return { promoted, rejected, decisions };
}
