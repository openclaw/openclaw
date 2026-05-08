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

// runDreamCycle is the consolidation pass over the episodic Markdown files:
// 1. pick low-decay candidates from <workspaceDir>/log-memory/*.md
// 2. embed them via the injected EmbedFn (entries don't carry vectors at rest)
// 3. greedy cosine clustering (>= 3 members)
// 4. LLM consolidation per cluster -> append semantic block to KNOWLEDGE.md
// 5. (unless dryRun) rewrite consumed entries out of their daily files
// 6. return DreamCycleResult (the host is free to log/persist the metrics)
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

  const candidates = await deps.store.selectDreamCandidates({
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

  const embeddings = await deps.embed(candidates.map((entry) => entry.payload.content));
  if (embeddings.length !== candidates.length) {
    deps.logger?.warn?.(
      `dream aborted: embed returned ${embeddings.length} vectors for ${candidates.length} entries`,
    );
    return {
      status: "skipped",
      reason: "insufficient_candidates",
      consumed: 0,
      produced: 0,
      clusters: 0,
      durationMs: Date.now() - startedAtMs,
    };
  }
  // Mutate in place — candidates are freshly loaded clones, no shared aliasing.
  for (let i = 0; i < candidates.length; i++) {
    candidates[i].embedding = embeddings[i];
  }
  const candidatesWithEmbeddings = candidates;

  const clusters = greedyClusterByCosine(candidatesWithEmbeddings, {
    threshold: CLUSTER_SIMILARITY_THRESHOLD,
    minClusterSize: MIN_CLUSTER_MEMBERS,
  });

  const consumed: LogMemoryEntry[] = [];
  let produced = 0;

  for (const cluster of clusters) {
    const consolidatedEntry = await consolidateCluster({
      cluster,
      consolidate: deps.consolidate,
      now,
      logger: deps.logger,
    });
    if (!consolidatedEntry) {
      continue;
    }
    await deps.store.appendSemantic(consolidatedEntry);
    produced++;
    consumed.push(...cluster.members);
  }

  if (!dryRun && consumed.length > 0) {
    // Non-destructive forgetting: mark the consumed entries as consolidated
    // (parallel to the `promotedAt` flag in short-term-promotion.ts). The raw
    // blocks stay on disk for audit / replay; default reads skip them.
    await deps.store.markConsolidated(
      consumed.map((entry) => entry.id),
      now,
    );
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
  const memberTags = collectMemberTags(input.cluster.members);
  const tags = dedupeTags([...memberTags, ...pattern.tags]);
  return {
    id: `dream:${input.now.getTime().toString(16)}:${hashTitle(pattern.title)}`,
    timestamp: input.now,
    layer: "semantic",
    payload: {
      type: "error_pattern",
      content: pattern.pattern,
      tags,
      source: "dream_consolidation",
      decayScore: CONSOLIDATED_DECAY,
      accessCount: 0,
      lastAccessedAt: input.now,
      title: pattern.title,
      rootCause: pattern.rootCause,
    },
  };
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
