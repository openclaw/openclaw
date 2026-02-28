/**
 * Memory Management Tools — Multi-store memory with consolidation pipeline
 *
 * Three stores:
 * - Working memory: 7 items, immediate context (in-session)
 * - Short-term memory: 200 items, 2-hour TTL
 * - Long-term memory: Persistent, consolidated from short-term
 *
 * Enhancements:
 * - R1: Recursive Memory Consolidation (grouping + summarization)
 * - R3: Context-Aware Pre-Compaction (session checkpoints)
 * - R4: Recursive Memory Search (iterative query refinement)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { getTypeDBClient } from "../knowledge/typedb-client.js";
import { MemoryQueries } from "../knowledge/typedb-queries.js";
import { textResult, resolveWorkspaceDir, generatePrefixedId } from "./common.js";
import { materializeMemoryItems } from "./memory-materializer.js";
import { loadObservationLog, saveObservationLog } from "./observation-store.js";
import { compressMessagesToObservations, formatObservationLog } from "./observer.js";
import { reflectObservations } from "./reflector.js";
import { extractReferencedDates, computeMemoryScore } from "./temporal-utils.js";

async function readJson(p: string) {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}
async function writeJson(p: string, d: any) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}
async function readMd(p: string) {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}
async function writeMd(p: string, c: string) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, c, "utf-8");
}

// ── Semantic recall via OpenClaw's hybrid search ──

type SemanticResult = { id: string; content: string; score: number; source: string };

async function semanticRecall(
  api: OpenClawPluginApi,
  agentId: string,
  query: string,
  limit: number,
): Promise<SemanticResult[] | null> {
  try {
    // Dynamic import path kept as a variable so TypeScript doesn't resolve
    // the file statically (it lives outside this extension's rootDir).
    const SEARCH_MANAGER_PATH = "../../../../src/memory/search-manager.js";
    const mod = await import(/* webpackIgnore: true */ SEARCH_MANAGER_PATH);
    const getMemorySearchManager = mod.getMemorySearchManager as (params: {
      cfg: any;
      agentId: string;
    }) => Promise<{ manager: any | null; error?: string }>;

    const { manager } = await getMemorySearchManager({
      cfg: api.config,
      agentId,
    });
    if (!manager) return null;

    const results = await manager.search(query, { maxResults: limit, minScore: 0.3 });
    return (results as any[]).map((r: any) => ({
      id: r.path,
      content: r.snippet,
      score: r.score,
      source: r.path,
    }));
  } catch {
    return null;
  }
}

// ── TypeDB result parsing ──

function parseTypeDBMemoryResults(response: any): Array<MemoryItem & { _store: string }> {
  try {
    if (!response || response.answerType !== "conceptRows" || !Array.isArray(response.answers)) {
      return [];
    }
    const items: Array<MemoryItem & { _store: string }> = [];
    for (const answer of response.answers) {
      const row = answer.data;
      if (!row) continue;
      const uid = row.$mid?.value ?? row.mid?.value;
      const content = row.$c?.value ?? row.c?.value;
      const memoryType = row.$t?.value ?? row.t?.value;
      const importance = row.$imp?.value ?? row.imp?.value;
      const storeName = row.$sn?.value ?? row.sn?.value;
      if (!uid || !content) continue;
      items.push({
        id: String(uid),
        content: String(content),
        type: (memoryType as MemoryItem["type"]) || "observation",
        importance: typeof importance === "number" ? importance : 0.5,
        source: "typedb",
        tags: [],
        created_at: new Date().toISOString(),
        accessed_at: new Date().toISOString(),
        access_count: 0,
        _store: String(storeName || "long_term"),
      });
    }
    return items;
  } catch {
    return [];
  }
}

// ── Native OpenClaw memory bridge ──
// Writes Markdown files in the format the native indexer auto-discovers
// (MEMORY.md for long-term, memory/YYYY-MM-DD.md for daily logs)

export async function writeNativeDailyLog(
  api: OpenClawPluginApi,
  agentId: string,
  entry: { type: string; content: string; source?: string; tags?: string[] },
) {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const timeStr = now.toISOString().split("T")[1].slice(0, 5);
  const logPath = join(resolveWorkspaceDir(api), "agents", agentId, "memory", `${dateStr}.md`);

  let md = await readMd(logPath);
  if (!md) {
    md = `# ${dateStr} — Agent Log\n`;
  }

  const tagsStr = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
  const sourceStr = entry.source ? ` (${entry.source})` : "";
  md += `\n## ${entry.type} (${timeStr} UTC)\n- ${entry.content}${tagsStr}${sourceStr}\n`;

  await writeMd(logPath, md);
}

export async function writeNativeLongTermMemory(
  api: OpenClawPluginApi,
  agentId: string,
  items: Array<{ type: string; content: string; importance?: number; tags?: string[] }>,
) {
  const dateStr = new Date().toISOString().split("T")[0];
  const memPath = join(resolveWorkspaceDir(api), "agents", agentId, "MEMORY.md");

  let md = await readMd(memPath);
  if (!md) {
    md = `# MEMORY.md - Long-Term Memory (${agentId})\n`;
  }

  md += `\n## Consolidated (${dateStr})\n`;
  for (const item of items) {
    const tagsStr = item.tags?.length ? ` [${item.tags.join(", ")}]` : "";
    md += `- [${item.type}] ${item.content}${tagsStr}\n`;
  }

  await writeMd(memPath, md);
}

// ── R1: derived_from field added for consolidation provenance ──

type MemoryItem = {
  id: string;
  content: string;
  type: "event" | "decision" | "outcome" | "lesson" | "fact" | "observation";
  importance: number; // 0.0-1.0
  source: string;
  tags: string[];
  created_at: string;
  accessed_at: string;
  access_count: number;
  derived_from?: string[]; // R1: IDs of source memories this was summarized from
  observed_at?: string; // When the event actually occurred (three-date model)
  referenced_dates?: string[]; // Dates extracted from content (three-date model)
};

type MemoryStore = {
  working: MemoryItem[]; // Max 7
  short_term: MemoryItem[]; // Max 200, 2hr TTL
  long_term: MemoryItem[]; // Persistent
  version: number;
};

const WORKING_LIMIT = 7;
const SHORT_TERM_LIMIT = 200;
const SHORT_TERM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function memoryPath(api: OpenClawPluginApi, agentId: string) {
  return join(resolveWorkspaceDir(api), "agents", agentId, "memory-store.json");
}

async function loadMemory(api: OpenClawPluginApi, agentId: string): Promise<MemoryStore> {
  const store = await readJson(memoryPath(api, agentId));
  if (!store) return { working: [], short_term: [], long_term: [], version: 0 };

  // Lazy migration: backfill three-date model fields on v1 stores
  if ((store.version ?? 0) < 2) {
    for (const key of ["working", "short_term", "long_term"] as const) {
      for (const item of store[key] ?? []) {
        if (!item.observed_at) item.observed_at = item.created_at;
        if (!item.referenced_dates) {
          item.referenced_dates = extractReferencedDates(item.content, new Date(item.created_at));
          if (item.referenced_dates.length === 0) item.referenced_dates = undefined;
        }
      }
    }
    store.version = 2;
    // Save migrated store (fire-and-forget)
    writeJson(memoryPath(api, agentId), store).catch(() => {});
  }

  return store;
}

async function saveMemory(api: OpenClawPluginApi, agentId: string, store: MemoryStore) {
  store.version++;
  await writeJson(memoryPath(api, agentId), store);
}

function pruneExpired(items: MemoryItem[], ttlMs: number): MemoryItem[] {
  const cutoff = Date.now() - ttlMs;
  return items.filter((i) => new Date(i.created_at).getTime() > cutoff);
}

// ── R1: Recursive Memory Consolidation helpers ──

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function groupRelatedMemories(items: MemoryItem[]): MemoryItem[][] {
  if (items.length === 0) return [];
  const groups: MemoryItem[][] = [];
  const assigned = new Set<string>();

  for (const item of items) {
    if (assigned.has(item.id)) continue;
    const group: MemoryItem[] = [item];
    assigned.add(item.id);

    for (const other of items) {
      if (assigned.has(other.id)) continue;
      if (jaccardSimilarity(item.tags, other.tags) > 0.3) {
        group.push(other);
        assigned.add(other.id);
      }
    }
    groups.push(group);
  }
  return groups;
}

function summarizeMemoryGroup(group: MemoryItem[]): MemoryItem {
  if (group.length === 1) return group[0];

  // Merge content into narrative
  const contents = group.map((g) => g.content);
  const mergedContent = `[Consolidated from ${group.length} memories] ${contents.join(" | ")}`;

  // Compute max importance, union tags, collect source IDs
  const maxImportance = Math.max(...group.map((g) => g.importance));
  const allTags = [...new Set(group.flatMap((g) => g.tags))];
  const derivedFrom = group.map((g) => g.id);
  const latestDate = group.reduce(
    (latest, g) => (g.created_at > latest ? g.created_at : latest),
    group[0].created_at,
  );

  // Use type of the highest-importance item
  const primaryItem = group.reduce(
    (best, g) => (g.importance > best.importance ? g : best),
    group[0],
  );

  return {
    id: generatePrefixedId("M"),
    content: mergedContent,
    type: primaryItem.type,
    importance: maxImportance,
    source: "consolidation",
    tags: allTags,
    created_at: latestDate,
    accessed_at: new Date().toISOString(),
    access_count: 0,
    derived_from: derivedFrom,
  };
}

// ── R4: Recursive Memory Search ──

async function recursiveMemorySearch(
  api: OpenClawPluginApi,
  agentId: string,
  query: string,
  maxDepth: number,
  limit: number,
  allItems: Array<MemoryItem & { _store: string }>,
): Promise<Array<MemoryItem & { _store: string; _depth: number }>> {
  const accumulatedIds = new Set<string>();
  const results: Array<MemoryItem & { _store: string; _depth: number }> = [];
  let currentQuery = query;

  for (let depth = 0; depth <= maxDepth && results.length < limit; depth++) {
    const q = currentQuery.toLowerCase();
    const matching = allItems
      .filter((i) => !accumulatedIds.has(i.id))
      .filter(
        (i) =>
          i.content.toLowerCase().includes(q) || i.tags.some((t) => t.toLowerCase().includes(q)),
      );

    for (const m of matching) {
      accumulatedIds.add(m.id);
      results.push({ ...m, _depth: depth });
    }

    if (depth < maxDepth && matching.length > 0) {
      // Extract new terms from results for query refinement
      const queryTerms = new Set(q.split(/\s+/));
      const newTerms = new Set<string>();
      for (const item of matching.slice(0, 5)) {
        const words = item.content
          .toLowerCase()
          .replace(/[^\w\s]/g, "")
          .split(/\s+/)
          .filter((w) => w.length > 3 && !queryTerms.has(w));
        for (const w of words) newTerms.add(w);
      }

      if (newTerms.size === 0) break;
      currentQuery = `${query} ${[...newTerms].slice(0, 3).join(" ")}`;
    }
  }

  return results.slice(0, limit);
}

// ── Parameter schemas ──

const MemoryStoreParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  content: Type.String({ description: "Memory content" }),
  type: Type.Union(
    [
      Type.Literal("event"),
      Type.Literal("decision"),
      Type.Literal("outcome"),
      Type.Literal("lesson"),
      Type.Literal("fact"),
      Type.Literal("observation"),
    ],
    { description: "Memory type" },
  ),
  importance: Type.Number({ description: "Importance 0.0-1.0 (affects consolidation priority)" }),
  source: Type.Optional(
    Type.String({ description: "Source (e.g., 'bdi-cycle', 'user-input', 'inference')" }),
  ),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for retrieval" })),
  store: Type.Optional(
    Type.Union([Type.Literal("working"), Type.Literal("short_term"), Type.Literal("long_term")], {
      description: "Target store (default: short_term)",
    }),
  ),
  observed_at: Type.Optional(
    Type.String({
      description:
        "When the event actually occurred (ISO date). Auto-extracted from content if not provided.",
    }),
  ),
});

const MemoryRecallParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  query: Type.Optional(
    Type.String({ description: "Search query (matched against content and tags)" }),
  ),
  type: Type.Optional(Type.String({ description: "Filter by memory type" })),
  store: Type.Optional(
    Type.Union(
      [
        Type.Literal("working"),
        Type.Literal("short_term"),
        Type.Literal("long_term"),
        Type.Literal("all"),
      ],
      { description: "Which store to search (default: all)" },
    ),
  ),
  limit: Type.Optional(Type.Number({ description: "Max results (default: 20)" })),
  min_importance: Type.Optional(Type.Number({ description: "Minimum importance filter" })),
  recursive_depth: Type.Optional(
    Type.Number({
      description:
        "Recursion depth for refined search. 0=direct (default), 1=search+refine+search, 2+=deeper. Max 3.",
    }),
  ),
});

const MemoryConsolidateParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  min_importance: Type.Optional(
    Type.Number({ description: "Minimum importance to promote (default: 0.6)" }),
  ),
  min_access_count: Type.Optional(
    Type.Number({ description: "Minimum access count to promote (default: 2)" }),
  ),
  dry_run: Type.Optional(Type.Boolean({ description: "Preview without saving (default: false)" })),
  summarize: Type.Optional(
    Type.Boolean({ description: "Summarize related items during consolidation (default: true)" }),
  ),
});

const MemoryStatusParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
});

// R3: Context-Aware Pre-Compaction checkpoint schema
const MemoryCheckpointParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  context: Type.String({ description: "Current task context" }),
  decisions: Type.Optional(Type.Array(Type.String(), { description: "Active decisions" })),
  findings: Type.Optional(Type.Array(Type.String(), { description: "Key findings" })),
  next_steps: Type.Optional(Type.Array(Type.String(), { description: "Next steps" })),
  open_questions: Type.Optional(Type.Array(Type.String(), { description: "Open questions" })),
});

const MemoryObserveParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  messages_summary: Type.Optional(
    Type.String({ description: "Summary of recent messages to compress into observations" }),
  ),
});

// ── R3: Resolve latest checkpoint for continuity after compaction ──

export async function resolveLatestCheckpoint(
  api: OpenClawPluginApi,
  agentId: string,
): Promise<string | null> {
  const checkpointDir = join(resolveWorkspaceDir(api), "agents", agentId, "memory", "checkpoints");
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(checkpointDir);
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort();
    if (mdFiles.length === 0) return null;
    const latestFile = mdFiles[mdFiles.length - 1];
    return await readMd(join(checkpointDir, latestFile));
  } catch {
    return null;
  }
}

// ── Tool factory ──

export function createMemoryTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "memory_store_item",
      label: "Store Memory",
      description:
        "Store an item in working, short-term, or long-term memory. Working memory holds 7 items. Short-term holds 200 with 2hr TTL.",
      parameters: MemoryStoreParams,
      async execute(_id: string, params: Static<typeof MemoryStoreParams>) {
        const mem = await loadMemory(api, params.agent_id);
        const now = new Date().toISOString();
        const targetStore = params.store || "short_term";

        // Three-date model: extract referenced dates and set observed_at
        const referencedDates = extractReferencedDates(params.content, new Date(now));
        const observedAt =
          params.observed_at || (referencedDates.length > 0 ? referencedDates[0] : undefined);

        const item: MemoryItem = {
          id: generatePrefixedId("M"),
          content: params.content,
          type: params.type,
          importance: params.importance,
          source: params.source || "manual",
          tags: params.tags || [],
          created_at: now,
          accessed_at: now,
          access_count: 0,
          observed_at: observedAt,
          referenced_dates: referencedDates.length > 0 ? referencedDates : undefined,
        };

        if (targetStore === "working") {
          mem.working.push(item);
          // Evict oldest if over limit
          if (mem.working.length > WORKING_LIMIT) {
            const evicted = mem.working.shift()!;
            mem.short_term.push(evicted); // Demote to short-term
          }
        } else if (targetStore === "short_term") {
          // Prune expired first
          mem.short_term = pruneExpired(mem.short_term, SHORT_TERM_TTL_MS);
          mem.short_term.push(item);
          if (mem.short_term.length > SHORT_TERM_LIMIT) {
            // Evict least important
            mem.short_term.sort((a, b) => a.importance - b.importance);
            mem.short_term.shift();
          }
        } else {
          mem.long_term.push(item);
        }

        await saveMemory(api, params.agent_id, mem);

        // Also append to memory-journal.md for human readability
        const mdPath = join(
          resolveWorkspaceDir(api),
          "agents",
          params.agent_id,
          "memory-journal.md",
        );
        let md = await readMd(mdPath);
        md += `\n- [${now.split("T")[0]}] [${params.type}] ${params.content}`;
        await writeMd(mdPath, md);

        // Bridge to native OpenClaw daily log format
        await writeNativeDailyLog(api, params.agent_id, {
          type: params.type,
          content: params.content,
          source: params.source,
          tags: params.tags,
        });

        // Trigger native memory index sync so new entries are immediately searchable
        try {
          const { getMemorySearchManager } =
            await import("../../../../src/memory/search-manager.js");
          const { manager } = await getMemorySearchManager({
            cfg: (api as any).config,
            agentId: params.agent_id,
          });
          if (manager?.sync) {
            // Fire-and-forget — don't block the tool response
            void (manager.sync as (opts: { reason: string }) => Promise<void>)({
              reason: "mabos-memory-store",
            }).catch(() => {});
          }
        } catch {
          // Native memory sync unavailable — files are still written,
          // native system will pick them up on next scheduled sync
        }

        // Write-through to TypeDB (best-effort)
        try {
          const client = getTypeDBClient();
          if (client.isAvailable()) {
            const typeql = MemoryQueries.storeItem(params.agent_id, {
              id: item.id,
              content: params.content,
              type: params.type,
              importance: params.importance,
              source: params.source || "manual",
              store: targetStore,
              tags: params.tags || [],
              observed_at: item.observed_at,
              referenced_dates: item.referenced_dates,
            });
            await client.insertData(typeql, `mabos_${params.agent_id.split("/")[0] || "default"}`);
          }
        } catch {
          // TypeDB unavailable — JSON + Markdown are source of truth
        }

        // Materialize to indexed Markdown for OpenClaw semantic search
        materializeMemoryItems(api, params.agent_id).catch(() => {});

        return textResult(
          `Memory ${item.id} stored in ${targetStore} (importance: ${params.importance}, type: ${params.type})`,
        );
      },
    },

    {
      name: "memory_recall",
      label: "Recall Memory",
      description:
        "Search across memory stores for relevant items by query, type, or importance. Supports recursive depth for iterative query refinement.",
      parameters: MemoryRecallParams,
      async execute(_id: string, params: Static<typeof MemoryRecallParams>) {
        const mem = await loadMemory(api, params.agent_id);
        const searchStore = params.store || "all";
        const limit = params.limit || 20;
        const minImp = params.min_importance || 0;

        // ── Step A: Collect items from JSON stores ──
        let items: Array<MemoryItem & { _store: string }> = [];
        if (searchStore === "all" || searchStore === "working") {
          items.push(...mem.working.map((i) => ({ ...i, _store: "working" as string })));
        }
        if (searchStore === "all" || searchStore === "short_term") {
          const pruned = pruneExpired(mem.short_term, SHORT_TERM_TTL_MS);
          items.push(...pruned.map((i) => ({ ...i, _store: "short_term" as string })));
        }
        if (searchStore === "all" || searchStore === "long_term") {
          items.push(...mem.long_term.map((i) => ({ ...i, _store: "long_term" as string })));
        }

        // ── Step B: Merge TypeDB results (previously discarded) ──
        try {
          const client = getTypeDBClient();
          if (client.isAvailable()) {
            const typeql = MemoryQueries.recallItems(params.agent_id, {
              query: params.query,
              type: params.type,
              store: params.store,
              minImportance: params.min_importance,
            });
            const typedbResponse = await client.matchQuery(
              typeql,
              `mabos_${params.agent_id.split("/")[0] || "default"}`,
            );
            const typedbItems = parseTypeDBMemoryResults(typedbResponse);
            // Merge: add TypeDB items not already in JSON (deduplicate by ID)
            const existingIds = new Set(items.map((i) => i.id));
            for (const tItem of typedbItems) {
              if (!existingIds.has(tItem.id)) {
                items.push(tItem);
                existingIds.add(tItem.id);
              }
            }
          }
        } catch {
          // TypeDB unavailable — continue with JSON items only
        }

        // ── Step C: Filter by type and importance ──
        if (params.type) items = items.filter((i) => i.type === params.type);
        if (minImp > 0) items = items.filter((i) => i.importance >= minImp);

        // ── Step D: Query filtering (with optional recursive depth — R4) ──
        const requestedDepth = Math.min(params.recursive_depth ?? 0, 3);
        let usedSemantic = false;
        let usedRecursive = false;

        if (params.query) {
          if (requestedDepth > 0) {
            // R4: Use recursive search (iterative deepening with query refinement)
            usedRecursive = true;
            const recursiveResults = await recursiveMemorySearch(
              api,
              params.agent_id,
              params.query,
              requestedDepth,
              limit,
              items,
            );
            // Sort by depth first (shallower = more directly relevant), then importance
            recursiveResults.sort((a, b) => {
              if (a._depth !== b._depth) return a._depth - b._depth;
              return b.importance - a.importance;
            });
            // Replace items with recursive results (cast back for downstream compat)
            items = recursiveResults;
          } else {
            // Original semantic + substring logic
            const semanticResults = await semanticRecall(
              api,
              params.agent_id,
              params.query,
              limit * 2,
            );

            if (semanticResults && semanticResults.length > 0) {
              usedSemantic = true;
              // Build a map of semantic scores by content snippet for fuzzy matching
              const semanticScoreMap = new Map<string, number>();
              for (const sr of semanticResults) {
                semanticScoreMap.set(sr.content.toLowerCase().trim(), sr.score);
              }

              // Re-score JSON items using unified scoring (three-date model)
              type ScoredItem = MemoryItem & { _store: string; _score: number };
              const scored: ScoredItem[] = items.map((item) => {
                const contentKey = item.content.toLowerCase().trim();
                const semanticScore = semanticScoreMap.get(contentKey);
                if (semanticScore !== undefined) {
                  return {
                    ...item,
                    _score: computeMemoryScore({ item, semanticScore, query: params.query }),
                  };
                }
                // Check for partial content overlap
                let bestPartialScore = 0;
                for (const [snippet, score] of semanticScoreMap) {
                  if (contentKey.includes(snippet) || snippet.includes(contentKey)) {
                    bestPartialScore = Math.max(bestPartialScore, score * 0.5);
                  }
                }
                if (bestPartialScore > 0) {
                  return {
                    ...item,
                    _score: computeMemoryScore({
                      item,
                      semanticScore: bestPartialScore,
                      query: params.query,
                    }),
                  };
                }
                // No semantic match — use importance + temporal scoring
                return { ...item, _score: computeMemoryScore({ item, query: params.query }) };
              });

              // Also include semantic-only results (from materialized files) that don't match JSON items
              const jsonContents = new Set(items.map((i) => i.content.toLowerCase().trim()));
              for (const sr of semanticResults) {
                const srKey = sr.content.toLowerCase().trim();
                if (!jsonContents.has(srKey) && sr.content.trim()) {
                  scored.push({
                    id: sr.id,
                    content: sr.content,
                    type: "observation" as const,
                    importance: sr.score,
                    source: sr.source,
                    tags: [],
                    created_at: new Date().toISOString(),
                    accessed_at: new Date().toISOString(),
                    access_count: 0,
                    _store: "semantic",
                    _score: sr.score,
                  });
                }
              }

              scored.sort((a, b) => b._score - a._score);
              items = scored.slice(0, limit);
            } else {
              // Semantic search unavailable or returned nothing — fall back to substring
              const q = params.query.toLowerCase();
              items = items.filter(
                (i) =>
                  i.content.toLowerCase().includes(q) ||
                  i.tags.some((t) => t.toLowerCase().includes(q)),
              );
              // Sort by unified memory score (three-date model)
              items.sort((a, b) => {
                const scoreA = computeMemoryScore({ item: a, query: params.query });
                const scoreB = computeMemoryScore({ item: b, query: params.query });
                return scoreB - scoreA;
              });
              items = items.slice(0, limit);
            }
          }
        } else {
          // No query — sort by unified memory score (three-date model)
          items.sort((a, b) => {
            const scoreA = computeMemoryScore({ item: a });
            const scoreB = computeMemoryScore({ item: b });
            return scoreB - scoreA;
          });
          items = items.slice(0, limit);
        }

        // ── Step E: Update access counts for JSON-backed items ──
        for (const item of items) {
          if (item._store === "semantic") continue; // Not a JSON store
          const storeKey = item._store as keyof MemoryStore;
          const original = (mem[storeKey] as MemoryItem[] | undefined)?.find(
            (i) => i.id === item.id,
          );
          if (original) {
            original.accessed_at = new Date().toISOString();
            original.access_count++;
          }
        }
        await saveMemory(api, params.agent_id, mem);

        if (items.length === 0) return textResult("No matching memories found.");

        const output = items
          .map((i) => {
            const depthStr = (i as any)._depth !== undefined ? `, depth: ${(i as any)._depth}` : "";
            return `- **${i.id}** [${i._store}] [${i.type}] (imp: ${i.importance}${depthStr}) — ${i.content}${i.tags.length ? ` [${i.tags.join(", ")}]` : ""}`;
          })
          .join("\n");

        const searchMethod = usedRecursive
          ? ` (recursive, depth: ${requestedDepth})`
          : usedSemantic
            ? " (semantic)"
            : "";
        return textResult(
          `## Memory Recall — ${params.agent_id}${searchMethod}\n\nFound ${items.length} items:\n\n${output}`,
        );
      },
    },

    {
      name: "memory_consolidate",
      label: "Consolidate Memory",
      description:
        "Promote important short-term memories to long-term storage. Based on importance and access frequency. Optionally groups and summarizes related items (R1).",
      parameters: MemoryConsolidateParams,
      async execute(_id: string, params: Static<typeof MemoryConsolidateParams>) {
        const mem = await loadMemory(api, params.agent_id);
        const minImp = params.min_importance ?? 0.6;
        const minAccess = params.min_access_count ?? 2;

        // Prune expired
        mem.short_term = pruneExpired(mem.short_term, SHORT_TERM_TTL_MS);

        // Find candidates for promotion
        const candidates = mem.short_term.filter(
          (i) => i.importance >= minImp || i.access_count >= minAccess,
        );

        // Also promote working memory items that are important
        const workingCandidates = mem.working.filter((i) => i.importance >= minImp);

        if (candidates.length === 0 && workingCandidates.length === 0) {
          return textResult(
            `No memories meet consolidation criteria (importance >= ${minImp} or access >= ${minAccess}).`,
          );
        }

        const allCandidates = [...candidates, ...workingCandidates];

        // R1: Optionally group and summarize related memories
        const shouldSummarize = params.summarize !== false; // default true
        let itemsToPromote: MemoryItem[];
        if (shouldSummarize && allCandidates.length > 1) {
          const groups = groupRelatedMemories(allCandidates);
          itemsToPromote = groups.map((g) => summarizeMemoryGroup(g));
        } else {
          itemsToPromote = allCandidates;
        }

        if (params.dry_run) {
          const summaryNote =
            shouldSummarize && allCandidates.length > 1
              ? `\n(${allCandidates.length} candidates grouped into ${itemsToPromote.length} items via summarization)`
              : "";
          return textResult(`## Consolidation Preview — ${params.agent_id}${summaryNote}

Would promote ${itemsToPromote.length} items to long-term:
${itemsToPromote.map((i) => `- ${i.id}: [${i.type}] ${i.content.slice(0, 80)}... (imp: ${i.importance}${i.derived_from ? `, derived from: ${i.derived_from.length} items` : ""})`).join("\n")}`);
        }

        // Promote: remove originals from short-term, add summarized items to long-term
        for (const c of candidates) {
          mem.short_term = mem.short_term.filter((i) => i.id !== c.id);
        }
        for (const item of itemsToPromote) {
          if (!mem.long_term.some((i) => i.id === item.id)) {
            mem.long_term.push(item);
          }
        }

        await saveMemory(api, params.agent_id, mem);

        // Bridge to native OpenClaw long-term memory format
        await writeNativeLongTermMemory(
          api,
          params.agent_id,
          itemsToPromote.map((c) => ({
            type: c.type,
            content: c.content,
            importance: c.importance,
            tags: c.tags,
          })),
        );

        // Promote in TypeDB too (best-effort)
        try {
          const client = getTypeDBClient();
          if (client.isAvailable()) {
            for (const c of itemsToPromote) {
              const typeql = MemoryQueries.storeItem(params.agent_id, {
                id: c.id,
                content: c.content,
                type: c.type,
                importance: c.importance,
                source: c.source,
                store: "long_term",
                tags: c.tags,
              });
              await client.insertData(
                typeql,
                `mabos_${params.agent_id.split("/")[0] || "default"}`,
              );
            }
          }
        } catch {
          // TypeDB unavailable
        }

        // Materialize to indexed Markdown for OpenClaw semantic search
        materializeMemoryItems(api, params.agent_id).catch(() => {});

        const summaryInfo =
          shouldSummarize && allCandidates.length > 1
            ? ` (${allCandidates.length} candidates grouped into ${itemsToPromote.length} summarized items)`
            : "";
        return textResult(`## Memory Consolidated — ${params.agent_id}

Promoted ${itemsToPromote.length} items to long-term memory${summaryInfo}.
- Working: ${mem.working.length}/${WORKING_LIMIT}
- Short-term: ${mem.short_term.length}/${SHORT_TERM_LIMIT}
- Long-term: ${mem.long_term.length} (persistent)`);
      },
    },

    {
      name: "memory_status",
      label: "Memory Status",
      description: "Show memory store status — counts, capacity, and recent items.",
      parameters: MemoryStatusParams,
      async execute(_id: string, params: Static<typeof MemoryStatusParams>) {
        const mem = await loadMemory(api, params.agent_id);
        const activeSt = pruneExpired(mem.short_term, SHORT_TERM_TTL_MS);

        return textResult(`## Memory Status — ${params.agent_id}

### Working Memory (${mem.working.length}/${WORKING_LIMIT})
${mem.working.length > 0 ? mem.working.map((i) => `- [${i.type}] ${i.content.slice(0, 60)}...`).join("\n") : "Empty."}

### Short-Term Memory (${activeSt.length}/${SHORT_TERM_LIMIT}, ${mem.short_term.length - activeSt.length} expired)
${
  activeSt.length > 0
    ? `Most recent: ${activeSt
        .slice(-3)
        .map((i) => `[${i.type}] ${i.content.slice(0, 60)}...`)
        .join(", ")}`
    : "Empty."
}

### Long-Term Memory (${mem.long_term.length} items)
${mem.long_term.length > 0 ? `Types: ${[...new Set(mem.long_term.map((i) => i.type))].join(", ")}` : "Empty."}

**Version:** ${mem.version}`);
      },
    },

    // R3: Context-Aware Pre-Compaction — Session Checkpoint
    {
      name: "memory_checkpoint",
      label: "Session Checkpoint",
      description:
        "Write a structured session checkpoint for post-compaction continuity. Stores current task context, decisions, findings, and next steps.",
      parameters: MemoryCheckpointParams,
      async execute(_id: string, params: Static<typeof MemoryCheckpointParams>) {
        const now = new Date();
        const dateStr = now.toISOString().split("T")[0];
        const timeStr = now.toISOString().split("T")[1].slice(0, 5).replace(":", "");
        const checkpointPath = join(
          resolveWorkspaceDir(api),
          "agents",
          params.agent_id,
          "memory",
          "checkpoints",
          `${dateStr}-${timeStr}.md`,
        );

        const lines: string[] = [
          `# Session Checkpoint — ${dateStr} ${now.toISOString().split("T")[1].slice(0, 5)} UTC`,
          "",
          "## Current Task Context",
          params.context,
          "",
        ];

        if (params.decisions?.length) {
          lines.push("## Active Decisions");
          for (const d of params.decisions) lines.push(`- ${d}`);
          lines.push("");
        }
        if (params.findings?.length) {
          lines.push("## Key Findings");
          for (const f of params.findings) lines.push(`- ${f}`);
          lines.push("");
        }
        if (params.next_steps?.length) {
          lines.push("## Next Steps");
          for (const s of params.next_steps) lines.push(`- ${s}`);
          lines.push("");
        }
        if (params.open_questions?.length) {
          lines.push("## Open Questions");
          for (const q of params.open_questions) lines.push(`- ${q}`);
          lines.push("");
        }

        await writeMd(checkpointPath, lines.join("\n"));

        return textResult(`Checkpoint saved to memory/checkpoints/${dateStr}-${timeStr}.md`);
      },
    },

    // Observer/Reflector compression tool
    {
      name: "memory_observe",
      label: "Observe & Compress",
      description:
        "Compress recent conversation messages into compact observations. Runs heuristic compression to reduce context size while preserving critical information.",
      parameters: MemoryObserveParams,
      async execute(_id: string, params: Static<typeof MemoryObserveParams>) {
        const log = await loadObservationLog(api, params.agent_id);

        // Compress the summary as a set of pseudo-messages if provided
        if (params.messages_summary) {
          const messages = [
            {
              role: "assistant" as const,
              content: params.messages_summary,
              timestamp: new Date().toISOString(),
            },
          ];
          const { observations, messagesCompressed, toolCallsCompressed } =
            compressMessagesToObservations(messages, log.observations);

          log.observations.push(...observations);
          log.total_messages_compressed += messagesCompressed;
          log.total_tool_calls_compressed += toolCallsCompressed;
          log.last_observer_run_at = new Date().toISOString();
        }

        // Run reflector if observation count is high
        if (log.observations.length > 100) {
          log.observations = reflectObservations(log.observations);
          log.last_reflector_run_at = new Date().toISOString();
        }

        await saveObservationLog(api, params.agent_id, log);

        const formatted = formatObservationLog(log.observations);
        return textResult(
          `Observations: ${log.observations.length} items (${log.total_messages_compressed} messages, ${log.total_tool_calls_compressed} tool calls compressed)\n\n${formatted}`,
        );
      },
    },
  ];
}
