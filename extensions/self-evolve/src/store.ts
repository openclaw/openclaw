import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  EpisodicStateFile,
  EpisodicTriplet,
  RetrievalCandidate,
  SelfEvolveConfig,
} from "./types.js";

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function validateTriplet(value: unknown): EpisodicTriplet | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.intent !== "string" ||
    typeof raw.experience !== "string" ||
    !Array.isArray(raw.embedding) ||
    typeof raw.qValue !== "number"
  ) {
    return null;
  }
  const embedding = raw.embedding.filter((value): value is number => typeof value === "number");
  return {
    id: raw.id,
    intent: raw.intent,
    experience: raw.experience,
    embedding,
    qValue: raw.qValue,
    visits: typeof raw.visits === "number" ? raw.visits : 0,
    selectedCount: typeof raw.selectedCount === "number" ? raw.selectedCount : 0,
    successCount: typeof raw.successCount === "number" ? raw.successCount : 0,
    lastReward: typeof raw.lastReward === "number" ? raw.lastReward : 0,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function scoreEntryValue(entry: EpisodicTriplet, now: number): number {
  const qNorm = clamp01((entry.qValue + 1) / 2);
  const successRate = clamp01(entry.successCount / Math.max(1, entry.visits));
  const ageMs = Math.max(0, now - entry.updatedAt);
  const ageDays = ageMs / 86_400_000;
  const recency = Math.exp(-ageDays / 30);
  const usefulness = clamp01(Math.log1p(entry.selectedCount) / Math.log1p(50));
  return 0.45 * qNorm + 0.2 * successRate + 0.2 * recency + 0.1 * usefulness;
}

function isRedundant(candidate: EpisodicTriplet, kept: EpisodicTriplet[]): boolean {
  for (const entry of kept) {
    if (cosineSimilarity(candidate.embedding, entry.embedding) > 0.92) {
      return true;
    }
  }
  return false;
}

function pruneByValue(entries: EpisodicTriplet[], maxEntries: number): EpisodicTriplet[] {
  if (entries.length <= maxEntries) {
    return entries;
  }
  const now = Date.now();
  const keep: EpisodicTriplet[] = [];
  const keptIds = new Set<string>();

  // Reserve a small quota for very recent memories so newly learned skills are not starved.
  const freshQuota = Math.max(1, Math.floor(maxEntries * 0.1));
  for (const fresh of [...entries].toSorted((left, right) => right.createdAt - left.createdAt)) {
    if (keep.length >= freshQuota) {
      break;
    }
    if (keptIds.has(fresh.id)) {
      continue;
    }
    keep.push(fresh);
    keptIds.add(fresh.id);
  }

  const ranked = [...entries].toSorted(
    (left, right) => scoreEntryValue(right, now) - scoreEntryValue(left, now),
  );
  for (const candidate of ranked) {
    if (keep.length >= maxEntries) {
      break;
    }
    if (keptIds.has(candidate.id)) {
      continue;
    }
    if (isRedundant(candidate, keep)) {
      continue;
    }
    keep.push(candidate);
    keptIds.add(candidate.id);
  }

  // Fallback fill: if de-dup removed too many, fill by value regardless of redundancy.
  for (const candidate of ranked) {
    if (keep.length >= maxEntries) {
      break;
    }
    if (keptIds.has(candidate.id)) {
      continue;
    }
    keep.push(candidate);
    keptIds.add(candidate.id);
  }

  return keep;
}

export class EpisodicStore {
  private entries: EpisodicTriplet[] = [];

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(contents) as EpisodicStateFile;
      const entries = Array.isArray(parsed.entries)
        ? parsed.entries
            .map((entry) => validateTriplet(entry))
            .filter((entry): entry is EpisodicTriplet => Boolean(entry))
        : [];
      this.entries = entries;
    } catch {
      this.entries = [];
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload: EpisodicStateFile = {
      version: 1,
      entries: this.entries,
    };
    await writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf8");
  }

  list(): EpisodicTriplet[] {
    return [...this.entries];
  }

  add(params: {
    intent: string;
    experience: string;
    embedding: number[];
    qInit: number;
    maxEntries: number;
  }): EpisodicTriplet {
    const now = Date.now();
    const triplet: EpisodicTriplet = {
      id: randomUUID(),
      intent: params.intent,
      experience: params.experience,
      embedding: params.embedding,
      qValue: params.qInit,
      visits: 0,
      selectedCount: 0,
      successCount: 0,
      lastReward: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(triplet);
    if (this.entries.length > params.maxEntries) {
      this.entries = pruneByValue(this.entries, params.maxEntries);
    }
    return triplet;
  }

  search(queryEmbedding: number[], config: SelfEvolveConfig): RetrievalCandidate[] {
    const candidates = this.entries
      .map((triplet) => ({
        triplet,
        similarity: cosineSimilarity(queryEmbedding, triplet.embedding),
      }))
      .filter((candidate) => candidate.similarity > config.retrieval.delta)
      .toSorted((left, right) => right.similarity - left.similarity)
      .slice(0, config.retrieval.k1);
    return candidates;
  }

  updateQ(params: {
    memoryIds: string[];
    reward: number;
    alpha: number;
    gamma: number;
    bootstrapNextMax?: number;
  }): void {
    if (params.memoryIds.length === 0) {
      return;
    }
    const idSet = new Set(params.memoryIds);
    for (const entry of this.entries) {
      if (!idSet.has(entry.id)) {
        continue;
      }
      const target = params.reward + params.gamma * (params.bootstrapNextMax ?? 0);
      entry.qValue = entry.qValue + params.alpha * (target - entry.qValue);
      entry.visits += 1;
      entry.selectedCount += 1;
      if (params.reward > 0) {
        entry.successCount += 1;
      }
      entry.lastReward = params.reward;
      entry.updatedAt = Date.now();
    }
  }
}
