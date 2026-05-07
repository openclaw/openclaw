import { randomUUID } from "node:crypto";
import { greedyClusterByCosine, type Cluster } from "./cluster.js";
import type { LogMemoryStore } from "./store.js";
import type { ConsolidateFn, DreamRecord, EmbedFn, LogMemoryEntry } from "./types.js";

const DEFAULT_DECAY_THRESHOLD = 0.25;
const DEFAULT_CANDIDATE_LIMIT = 300;
const MIN_CANDIDATE_COUNT = 15;
const MIN_CLUSTER_MEMBERS = 3;
const CONSOLIDATED_DECAY = 0.9;
const CLUSTER_SIMILARITY_THRESHOLD = 0.82;

export interface DreamCycleOptions {
  trigger?: DreamRecord["trigger"];
  dryRun?: boolean;
}

export interface DreamCycleResult {
  status: "skipped" | "completed";
  reason?: "insufficient_candidates";
  consumed: number;
  produced: number;
  clusters: number;
  durationMs: number;
  dreamRecord?: DreamRecord;
}

// runDreamCycle is the consolidation pass over the episodic layer:
// 1. pick low-decay candidates
// 2. greedy cosine clustering
// 3. LLM consolidation per cluster -> semantic entries
// 4. (unless dryRun) prune the consumed episodic entries
// 5. record metrics in dream_records
export async function runDreamCycle(deps: {
  store: LogMemoryStore;
  embed: EmbedFn;
  consolidate: ConsolidateFn;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  now?: () => Date;
  options?: DreamCycleOptions;
}): Promise<DreamCycleResult> {
  const now = deps.now?.() ?? new Date();
  const trigger = deps.options?.trigger ?? "manual";
  const dryRun = deps.options?.dryRun ?? false;
  const startedAtMs = now.getTime();

  const candidates = deps.store.selectDreamCandidates({
    threshold: DEFAULT_DECAY_THRESHOLD,
    limit: DEFAULT_CANDIDATE_LIMIT,
    now,
  });

  if (candidates.length < MIN_CANDIDATE_COUNT) {
    deps.logger?.info?.("dream skipped: insufficient candidates");
    return {
      status: "skipped",
      reason: "insufficient_candidates",
      consumed: 0,
      produced: 0,
      clusters: 0,
      durationMs: Date.now() - startedAtMs,
    };
  }

  const clusters = greedyClusterByCosine(candidates, {
    threshold: CLUSTER_SIMILARITY_THRESHOLD,
    minClusterSize: MIN_CLUSTER_MEMBERS,
  });

  const consumed: LogMemoryEntry[] = [];
  let produced = 0;

  for (const cluster of clusters) {
    const consolidatedEntry = await consolidateCluster({
      cluster,
      consolidate: deps.consolidate,
      embed: deps.embed,
      now,
      logger: deps.logger,
    });
    if (!consolidatedEntry) {
      continue;
    }
    deps.store.upsert(consolidatedEntry);
    produced++;
    consumed.push(...cluster.members);
  }

  if (!dryRun && consumed.length > 0) {
    deps.store.delete(consumed.map((entry) => entry.id));
  }

  const durationMs = Date.now() - startedAtMs;
  const dreamRecord: DreamRecord = {
    dreamId: randomUUID(),
    triggeredAt: now,
    trigger,
    episodicConsumed: consumed.length,
    semanticProduced: produced,
    durationMs,
  };
  deps.store.insertDreamRecord(dreamRecord);
  deps.logger?.info?.(
    `dream complete: consumed ${consumed.length} episodic → produced ${produced} semantic`,
  );

  return {
    status: "completed",
    consumed: consumed.length,
    produced,
    clusters: clusters.length,
    durationMs,
    dreamRecord,
  };
}

async function consolidateCluster(input: {
  cluster: Cluster;
  consolidate: ConsolidateFn;
  embed: EmbedFn;
  now: Date;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}): Promise<LogMemoryEntry | null> {
  let pattern;
  try {
    pattern = await input.consolidate({ members: input.cluster.members });
  } catch (err) {
    input.logger?.warn?.(
      `dream consolidation threw, skipping cluster: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (!pattern) {
    input.logger?.warn?.("dream consolidation returned no pattern, skipping cluster");
    return null;
  }
  const content = formatConsolidatedContent(pattern);
  const [embedding] = await input.embed([content]);
  const id = `dream:${input.now.getTime().toString(16)}:${hashTitle(pattern.title)}`;
  const memberTags = collectMemberTags(input.cluster.members);
  return {
    id,
    timestamp: input.now,
    layer: "semantic",
    embedding,
    payload: {
      type: "error_pattern",
      content,
      tags: dedupeTags([...memberTags, ...pattern.tags]),
      source: "dream_consolidation",
      decayScore: CONSOLIDATED_DECAY,
      accessCount: 0,
      lastAccessedAt: input.now,
    },
  };
}

function formatConsolidatedContent(pattern: {
  title: string;
  pattern: string;
  rootCause: string;
}): string {
  return [
    `Title: ${pattern.title}`,
    `Pattern: ${pattern.pattern}`,
    `Root cause: ${pattern.rootCause}`,
  ].join("\n");
}

function collectMemberTags(members: LogMemoryEntry[]): string[] {
  const out = new Set<string>();
  for (const member of members) {
    for (const tag of member.payload.tags) {
      out.add(tag);
    }
  }
  return [...out];
}

function dedupeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
}

function hashTitle(title: string): string {
  // Tiny stable hash — ids only need to be unique within a run, not strong.
  let h = 0;
  for (let i = 0; i < title.length; i++) {
    h = (Math.imul(h, 31) + title.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
