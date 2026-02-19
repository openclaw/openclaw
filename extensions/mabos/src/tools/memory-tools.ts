/**
 * Memory Management Tools — Multi-store memory with consolidation pipeline
 *
 * Three stores:
 * - Working memory: 7 items, immediate context (in-session)
 * - Short-term memory: 200 items, 2-hour TTL
 * - Long-term memory: Persistent, consolidated from short-term
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { getTypeDBClient } from "../knowledge/typedb-client.js";
import { MemoryQueries } from "../knowledge/typedb-queries.js";
import { textResult, resolveWorkspaceDir } from "./common.js";

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
  return store || { working: [], short_term: [], long_term: [], version: 0 };
}

async function saveMemory(api: OpenClawPluginApi, agentId: string, store: MemoryStore) {
  store.version++;
  await writeJson(memoryPath(api, agentId), store);
}

function pruneExpired(items: MemoryItem[], ttlMs: number): MemoryItem[] {
  const cutoff = Date.now() - ttlMs;
  return items.filter((i) => new Date(i.created_at).getTime() > cutoff);
}

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
});

const MemoryStatusParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
});

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

        const item: MemoryItem = {
          id: `M-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          content: params.content,
          type: params.type,
          importance: params.importance,
          source: params.source || "manual",
          tags: params.tags || [],
          created_at: now,
          accessed_at: now,
          access_count: 0,
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

        // Also append to Memory.md for human readability
        const mdPath = join(resolveWorkspaceDir(api), "agents", params.agent_id, "Memory.md");
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
            });
            await client.insertData(typeql, `mabos_${params.agent_id.split("/")[0] || "default"}`);
          }
        } catch {
          // TypeDB unavailable — JSON + Markdown are source of truth
        }

        return textResult(
          `Memory ${item.id} stored in ${targetStore} (importance: ${params.importance}, type: ${params.type})`,
        );
      },
    },

    {
      name: "memory_recall",
      label: "Recall Memory",
      description: "Search across memory stores for relevant items by query, type, or importance.",
      parameters: MemoryRecallParams,
      async execute(_id: string, params: Static<typeof MemoryRecallParams>) {
        // Try TypeDB first (exercise connection), fall back to JSON
        try {
          const client = getTypeDBClient();
          if (client.isAvailable()) {
            const typeql = MemoryQueries.recallItems(params.agent_id, {
              query: params.query,
              type: params.type,
              store: params.store,
              minImportance: params.min_importance,
            });
            await client.matchQuery(typeql, `mabos_${params.agent_id.split("/")[0] || "default"}`);
          }
        } catch {
          // Fall through to JSON
        }

        const mem = await loadMemory(api, params.agent_id);
        const searchStore = params.store || "all";
        const limit = params.limit || 20;
        const minImp = params.min_importance || 0;

        // Collect items from requested stores
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

        // Filter
        if (params.type) items = items.filter((i) => i.type === params.type);
        if (minImp > 0) items = items.filter((i) => i.importance >= minImp);
        if (params.query) {
          const q = params.query.toLowerCase();
          items = items.filter(
            (i) =>
              i.content.toLowerCase().includes(q) ||
              i.tags.some((t) => t.toLowerCase().includes(q)),
          );
        }

        // Sort by importance × recency
        items.sort((a, b) => {
          const scoreA =
            a.importance * 0.6 +
            (1 - (Date.now() - new Date(a.created_at).getTime()) / (24 * 60 * 60 * 1000)) * 0.4;
          const scoreB =
            b.importance * 0.6 +
            (1 - (Date.now() - new Date(b.created_at).getTime()) / (24 * 60 * 60 * 1000)) * 0.4;
          return scoreB - scoreA;
        });

        items = items.slice(0, limit);

        // Update access counts
        for (const item of items) {
          const storeKey = item._store as keyof MemoryStore;
          const original = (mem[storeKey] as MemoryItem[]).find((i) => i.id === item.id);
          if (original) {
            original.accessed_at = new Date().toISOString();
            original.access_count++;
          }
        }
        await saveMemory(api, params.agent_id, mem);

        if (items.length === 0) return textResult("No matching memories found.");

        const output = items
          .map(
            (i) =>
              `- **${i.id}** [${i._store}] [${i.type}] (imp: ${i.importance}) — ${i.content}${i.tags.length ? ` [${i.tags.join(", ")}]` : ""}`,
          )
          .join("\n");

        return textResult(
          `## Memory Recall — ${params.agent_id}\n\nFound ${items.length} items:\n\n${output}`,
        );
      },
    },

    {
      name: "memory_consolidate",
      label: "Consolidate Memory",
      description:
        "Promote important short-term memories to long-term storage. Based on importance and access frequency.",
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

        if (params.dry_run) {
          return textResult(`## Consolidation Preview — ${params.agent_id}

Would promote ${allCandidates.length} items to long-term:
${allCandidates.map((i) => `- ${i.id}: [${i.type}] ${i.content.slice(0, 80)}... (imp: ${i.importance}, accessed: ${i.access_count}×)`).join("\n")}`);
        }

        // Promote
        for (const c of candidates) {
          mem.short_term = mem.short_term.filter((i) => i.id !== c.id);
          mem.long_term.push(c);
        }
        for (const c of workingCandidates) {
          // Don't remove from working — just copy to long-term
          if (!mem.long_term.some((i) => i.id === c.id)) {
            mem.long_term.push(c);
          }
        }

        await saveMemory(api, params.agent_id, mem);

        // Bridge to native OpenClaw long-term memory format
        await writeNativeLongTermMemory(
          api,
          params.agent_id,
          allCandidates.map((c) => ({
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
            for (const c of allCandidates) {
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

        return textResult(`## Memory Consolidated — ${params.agent_id}

Promoted ${allCandidates.length} items to long-term memory.
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
  ];
}
