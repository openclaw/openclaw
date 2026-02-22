/**
 * ChromaDB Memory Plugin for OpenClaw
 *
 * Provides:
 * 1. chromadb_search tool - manual semantic search over ChromaDB
 * 2. Auto-recall - injects relevant memories before each agent turn
 *
 * Uses local Ollama (nomic-embed-text) for embeddings. No cloud APIs.
 *
 * Multi-agent support: set `collectionMap` in config to route different
 * agents to different ChromaDB collections:
 *
 *   "chromadb-memory": {
 *     "config": {
 *       "collectionName": "longterm_memory",
 *       "collectionMap": {
 *         "main": "longterm_memory",
 *         "regina": "regina_memory"
 *       }
 *     }
 *   }
 *
 * If collectionMap is not set, all agents share collectionName (original behaviour).
 */

// Use plain JSON Schema instead of typebox (not available in workspace context)
type OpenClawPluginApi = any;

// ============================================================================
// Config
// ============================================================================

interface ChromaDBConfig {
  chromaUrl: string;
  collectionId: string;
  collectionName: string;
  collectionMap: Record<string, string>;
  ollamaUrl: string;
  embeddingModel: string;
  autoRecall: boolean;
  autoRecallResults: number;
  minScore: number;
}

function parseConfig(raw: unknown): ChromaDBConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  return {
    chromaUrl: (cfg.chromaUrl as string) || "http://localhost:8100",
    collectionId: (cfg.collectionId as string) || "",
    collectionName: (cfg.collectionName as string) || "longterm_memory",
    collectionMap: (cfg.collectionMap as Record<string, string>) || {},
    ollamaUrl: (cfg.ollamaUrl as string) || "http://localhost:11434",
    embeddingModel: (cfg.embeddingModel as string) || "nomic-embed-text",
    autoRecall: cfg.autoRecall !== false,
    autoRecallResults: (cfg.autoRecallResults as number) || 3,
    minScore: (cfg.minScore as number) || 0.5,
  };
}

/** Resolve which collectionName to use for a given agentId. */
function collectionNameForAgent(cfg: ChromaDBConfig, agentId?: string): string {
  if (agentId && cfg.collectionMap[agentId]) {
    return cfg.collectionMap[agentId];
  }
  return cfg.collectionName;
}

// ============================================================================
// Ollama Embeddings
// ============================================================================

async function getEmbedding(
  ollamaUrl: string,
  model: string,
  text: string,
): Promise<number[]> {
  const resp = await fetch(`${ollamaUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });

  if (!resp.ok) {
    throw new Error(`Ollama embedding failed: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as { embedding: number[] };
  return data.embedding;
}

// ============================================================================
// ChromaDB Client
// ============================================================================

interface ChromaResult {
  source: string;
  text: string;
  distance: number;
  score: number;
  metadata: Record<string, string>;
}

const CHROMA_BASE = "/api/v2/tenants/default_tenant/databases/default_database/collections";

// Per-collectionName cache of resolved IDs (avoids cross-agent cache collisions)
const _resolvedCollectionIds = new Map<string, string>();
let _consecutiveFailures = 0;

async function resolveCollectionId(
  chromaUrl: string,
  collectionId: string,
  collectionName: string,
): Promise<string> {
  // If we already resolved this name this session, reuse
  const cached = _resolvedCollectionIds.get(collectionName);
  if (cached) return cached;

  // If collectionId is set AND matches the expected name, verify it still exists
  if (collectionId) {
    try {
      const resp = await fetch(`${chromaUrl}${CHROMA_BASE}/${collectionId}`);
      if (resp.ok) {
        _resolvedCollectionIds.set(collectionName, collectionId);
        return collectionId;
      }
    } catch {
      // Fall through to name lookup
    }
  }

  // Look up by name
  const resp = await fetch(`${chromaUrl}${CHROMA_BASE}`);
  if (!resp.ok) throw new Error(`ChromaDB list collections failed: ${resp.status}`);

  const collections = (await resp.json()) as Array<{ id: string; name: string }>;
  const match = collections.find((c) => c.name === collectionName);

  if (!match) {
    throw new Error(`ChromaDB collection "${collectionName}" not found. Available: ${collections.map((c) => c.name).join(", ")}`);
  }

  _resolvedCollectionIds.set(collectionName, match.id);
  return match.id;
}

// Extract potential keywords (capitalized words, quoted phrases) for hybrid search
function extractKeywords(query: string): string[] {
  const keywords: string[] = [];

  // Capitalized words (likely proper nouns) — exclude common sentence starters
  const commonStarters = new Set(["what", "who", "where", "when", "how", "why", "the", "a", "an", "is", "are", "do", "does", "did", "can", "could", "would", "should", "my", "his", "her", "their", "search", "find", "tell", "remember", "about", "from"]);
  const words = query.split(/\s+/);
  for (const word of words) {
    const clean = word.replace(/[^a-zA-Z]/g, "");
    if (clean.length >= 3 && clean[0] === clean[0].toUpperCase() && clean[0] !== clean[0].toLowerCase()) {
      if (!commonStarters.has(clean.toLowerCase())) {
        keywords.push(clean);
      }
    }
  }

  // Quoted phrases
  const quoted = query.match(/"([^"]+)"/g);
  if (quoted) {
    for (const q of quoted) {
      keywords.push(q.replace(/"/g, ""));
    }
  }

  return [...new Set(keywords)];
}

async function queryChromaDBRaw(
  chromaUrl: string,
  collectionId: string,
  embedding: number[],
  nResults: number,
  whereDocument?: Record<string, string>,
): Promise<ChromaResult[]> {
  const url = `${chromaUrl}${CHROMA_BASE}/${collectionId}/query`;

  const body: Record<string, unknown> = {
    query_embeddings: [embedding],
    n_results: nResults,
    include: ["documents", "metadatas", "distances"],
  };
  if (whereDocument) {
    body.where_document = whereDocument;
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`ChromaDB query failed: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as {
    ids: string[][];
    documents: string[][];
    metadatas: Record<string, string>[][];
    distances: number[][];
  };

  if (!data.ids?.[0]?.length) return [];

  return data.ids[0].map((id, i) => ({
    source: data.metadatas[0][i]?.source || "unknown",
    text: data.documents[0][i] || "",
    distance: data.distances[0][i],
    score: 1 - data.distances[0][i],
    metadata: data.metadatas[0][i] || {},
  }));
}

// Hybrid search: vector + keyword queries merged and deduplicated
async function queryChromaDBHybrid(
  chromaUrl: string,
  collectionId: string,
  embedding: number[],
  nResults: number,
  query: string,
): Promise<ChromaResult[]> {
  const keywords = extractKeywords(query);

  // Always do vector search
  const vectorResults = await queryChromaDBRaw(chromaUrl, collectionId, embedding, nResults);

  if (keywords.length === 0) {
    return vectorResults;
  }

  // Do keyword-filtered searches for each keyword
  const keywordResults: ChromaResult[] = [];
  for (const kw of keywords.slice(0, 3)) { // Limit to 3 keywords
    try {
      const kwResults = await queryChromaDBRaw(
        chromaUrl, collectionId, embedding, nResults,
        { "$contains": kw },
      );
      keywordResults.push(...kwResults);
    } catch {
      // Keyword filter failed, skip
    }
  }

  // Merge and deduplicate — keyword matches get a score boost
  const seen = new Map<string, ChromaResult>();

  for (const r of vectorResults) {
    const key = `${r.source}:${r.text.slice(0, 50)}`;
    seen.set(key, r);
  }

  for (const r of keywordResults) {
    const key = `${r.source}:${r.text.slice(0, 50)}`;
    if (seen.has(key)) {
      // Boost score for results found by both vector AND keyword
      const existing = seen.get(key)!;
      existing.score = Math.min(1, existing.score + 0.1);
    } else {
      // Keyword-only results get a small boost for exact match relevance
      r.score = Math.min(1, r.score + 0.05);
      seen.set(key, r);
    }
  }

  // Sort by score descending and return top N
  return [...seen.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, nResults);
}

// ============================================================================
// Plugin
// ============================================================================

export default function register(api: OpenClawPluginApi) {
  const cfg = parseConfig(api.pluginConfig);

  if (!cfg.collectionId && !cfg.collectionName) {
    api.logger.warn("chromadb-memory: No collectionId or collectionName configured, plugin disabled");
    return;
  }

  const hasCollectionMap = Object.keys(cfg.collectionMap).length > 0;

  api.logger.info(
    `chromadb-memory: registered (chroma: ${cfg.chromaUrl}, collection: ${cfg.collectionId || cfg.collectionName}${hasCollectionMap ? `, collectionMap: [${Object.keys(cfg.collectionMap).join(", ")}]` : ""}, ollama: ${cfg.ollamaUrl}, model: ${cfg.embeddingModel})`,
  );

  // Helper to get resolved collection ID for a given agentId
  async function getCollectionId(agentId?: string): Promise<string> {
    const name = collectionNameForAgent(cfg, agentId);
    // For the default collection, also accept the static collectionId shortcut
    const staticId = (agentId === undefined || name === cfg.collectionName) ? cfg.collectionId : "";
    return resolveCollectionId(cfg.chromaUrl, staticId, name);
  }

  // ========================================================================
  // Tool: chromadb_search
  // ========================================================================

  // Register as a factory so each agent gets its own tool instance with the
  // correct agentId captured at creation time (not at call time).
  api.registerTool((toolCtx) => ({
    name: "chromadb_search",
    description:
      "Search the ChromaDB long-term memory archive. Contains indexed memory files, session transcripts, and homelab documentation. Use when you need deep historical context or can't find something in memory_search.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Semantic search query" },
        limit: { type: "number", description: "Max results (default: 5)" },
      },
      required: ["query"],
    },
    async execute(_toolCallId, params) {
      const { query, limit = 5 } = params as {
        query: string;
        limit?: number;
      };

      try {
        const agentId = toolCtx.agentId; // captured per-agent at tool creation
        const collectionId = await getCollectionId(agentId);
        const embedding = await getEmbedding(
          cfg.ollamaUrl,
          cfg.embeddingModel,
          query,
        );
        const results = await queryChromaDBHybrid(
          cfg.chromaUrl,
          collectionId,
          embedding,
          limit,
          query,
        );

        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: "No relevant results found in ChromaDB." },
            ],
          };
        }

        const filtered = results.filter((r) => r.score >= cfg.minScore);

        if (filtered.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Found ${results.length} results but none above similarity threshold (${cfg.minScore}). Best match: ${results[0].score.toFixed(3)} from ${results[0].source}`,
              },
            ],
          };
        }

        const text = filtered
          .map(
            (r, i) =>
              `### Result ${i + 1} — ${r.source} (${(r.score * 100).toFixed(0)}% match)\n${r.text.slice(0, 500)}${r.text.length > 500 ? "..." : ""}`,
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${filtered.length} results from ChromaDB:\n\n${text}`,
            },
          ],
        };
      } catch (err) {
        // Clear cache for the affected collection on error
        const name = collectionNameForAgent(cfg, toolCtx.agentId);
        _resolvedCollectionIds.delete(name);
        return {
          content: [
            {
              type: "text",
              text: `ChromaDB search error: ${String(err)}\nHint: Collection ID may be stale. Will auto-resolve on next query.`,
            },
          ],
          isError: true,
        };
      }
    },
  }));

  // ========================================================================
  // Auto-recall: inject relevant memories before each agent turn
  // ========================================================================

  if (cfg.autoRecall) {
    api.on("before_agent_start", async (event: { prompt?: string; messages?: unknown[] }, ctx?: { agentId?: string; sessionKey?: string }) => {
      if (!event.prompt || event.prompt.length < 10) return;

      // agentId comes from the second ctx parameter (not the event)
      const agentId = ctx?.agentId;

      try {
        const collectionId = await getCollectionId(agentId);
        const embedding = await getEmbedding(
          cfg.ollamaUrl,
          cfg.embeddingModel,
          event.prompt,
        );
        const results = await queryChromaDBHybrid(
          cfg.chromaUrl,
          collectionId,
          embedding,
          cfg.autoRecallResults,
          event.prompt,
        );

        // Filter by minimum similarity
        const relevant = results.filter((r) => r.score >= cfg.minScore);
        if (relevant.length === 0) {
          const colName = collectionNameForAgent(cfg, agentId);
          api.logger.info(`chromadb-memory: auto-recall no results above minScore for agent "${agentId ?? "default"}" (collection: ${colName}, candidates: ${results.length}, minScore: ${cfg.minScore})`);
          return;
        }

        const memoryContext = relevant
          .map(
            (r) =>
              `- [${r.source}] ${r.text.slice(0, 300)}${r.text.length > 300 ? "..." : ""}`,
          )
          .join("\n");

        _consecutiveFailures = 0; // Reset on success
        api.logger.info(
          `chromadb-memory: auto-recall injecting ${relevant.length} memories for agent "${agentId ?? "default"}" (best: ${relevant[0].score.toFixed(3)} from ${relevant[0].source})`,
        );

        return {
          prependContext: `<chromadb-memories>\nRelevant context from long-term memory (ChromaDB):\n${memoryContext}\n</chromadb-memories>`,
        };
      } catch (err) {
        _consecutiveFailures++;
        // Clear cache for the affected collection on error
        const name = collectionNameForAgent(cfg, agentId);
        _resolvedCollectionIds.delete(name);
        const errMsg = String(err);
        api.logger.warn(`chromadb-memory: auto-recall failed for agent "${agentId ?? "default"}" (${_consecutiveFailures}x): ${errMsg}`);

        // Surface the failure to the agent so it's not silently blind
        const severity = _consecutiveFailures >= 3 ? "⚠️ PERSISTENT" : "⚠️";
        return {
          prependContext: `<chromadb-memory-error>\n${severity} ChromaDB long-term memory unavailable: ${errMsg}\n${_consecutiveFailures >= 3 ? "This has failed " + _consecutiveFailures + " times in a row. Collection may need reindexing or ChromaDB may be down.\n" : ""}Falling back to memory_search (local embeddings) only.\n</chromadb-memory-error>`,
        };
      }
    });
  }

  // ========================================================================
  // Service
  // ========================================================================

  api.registerService({
    id: "chromadb-memory",
    start: () => {
      api.logger.info(
        `chromadb-memory: service started (auto-recall: ${cfg.autoRecall}, collection: ${cfg.collectionId || cfg.collectionName}${hasCollectionMap ? `, multi-agent map: ${JSON.stringify(cfg.collectionMap)}` : ""})`,
      );
    },
    stop: () => {
      api.logger.info("chromadb-memory: stopped");
    },
  });
}
