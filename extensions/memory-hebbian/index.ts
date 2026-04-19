import { createMemoryGetTool, createMemorySearchTool } from "@openclaw/memory-core/api.js";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

// ---------------------------------------------------------------------------
// Hebbian config
// ---------------------------------------------------------------------------

interface HebbianConfig {
  endpoint: string;
  strengthenAmount: number;
  maxResults: number;
  enabled: boolean;
}

function resolveHebbianConfig(pluginConfig?: Record<string, unknown>): HebbianConfig {
  return {
    endpoint: (pluginConfig?.endpoint as string) ?? "http://localhost:8888",
    strengthenAmount: (pluginConfig?.strengthenAmount as number) ?? 0.05,
    maxResults: (pluginConfig?.maxResults as number) ?? 5,
    enabled: (pluginConfig?.enabled as boolean) ?? true,
  };
}

// ---------------------------------------------------------------------------
// Hebbian REST helpers
// ---------------------------------------------------------------------------

const HEBBIAN_TIMEOUT_MS = 3_000;

interface HebbianSearchResult {
  id: string;
  summary: string;
  score: number;
  source: string;
}

interface HebbianNodeDetail {
  id: string;
  content: string;
  summary: string;
  source: string;
  tags: string;
}

async function hebbianFetch(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEBBIAN_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function searchHebbian(
  endpoint: string,
  query: string,
  maxResults: number,
): Promise<HebbianSearchResult[]> {
  const url = `${endpoint}/search?q=${encodeURIComponent(query)}&mode=hybrid&limit=${maxResults}`;
  const res = await hebbianFetch(url);
  if (!res.ok) {
    throw new Error(`Hebbian search returned ${res.status}`);
  }
  const data = (await res.json()) as { results?: HebbianSearchResult[] };
  return data.results ?? [];
}

async function getHebbianNode(endpoint: string, id: string): Promise<HebbianNodeDetail | null> {
  const res = await hebbianFetch(`${endpoint}/nodes/${encodeURIComponent(id)}`);
  if (!res.ok) {
    return null;
  }
  return (await res.json()) as HebbianNodeDetail;
}

/**
 * Fire-and-forget: strengthen the edges between coaccessed nodes so that
 * "neurons that fire together wire together".
 */
function strengthenCoaccessed(endpoint: string, nodeIds: string[], amount: number): void {
  if (nodeIds.length < 2) {
    return;
  }
  hebbianFetch(`${endpoint}/strengthen-coaccessed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_ids: nodeIds, amount }),
  }).catch(() => {
    // Silently ignore – this is best-effort background reinforcement.
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const memoryHebbianPlugin = {
  id: "memory-hebbian",
  name: "Memory (Hebbian)",
  description: "File-backed memory search with Hebbian graph memory augmentation",
  kind: "memory" as const,
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      endpoint: { type: "string" as const, default: "http://localhost:8888" },
      strengthenAmount: { type: "number" as const, default: 0.05 },
      maxResults: { type: "number" as const, default: 5 },
      enabled: { type: "boolean" as const, default: true },
    },
  },

  register(api: OpenClawPluginApi) {
    const hebbianCfg = resolveHebbianConfig(api.pluginConfig);

    api.registerTool(
      (ctx) => {
        // Create the standard (core) memory tools from memory-core extension.
        const standardSearchTool = createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryGetTool = createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });

        if (!standardSearchTool || !memoryGetTool) {
          return null;
        }

        // When Hebbian is disabled, behave identically to memory-core.
        if (!hebbianCfg.enabled) {
          return [standardSearchTool, memoryGetTool];
        }

        // Build an augmented memory_search tool that queries both sources.
        const augmentedSearchTool: AnyAgentTool = {
          ...standardSearchTool,
          execute: async (toolCallId: string, params: unknown) => {
            const p = (params ?? {}) as Record<string, unknown>;
            const query = typeof p.query === "string" ? p.query : "";

            // Run standard search and Hebbian search in parallel.
            const [standardResult, hebbianHits] = await Promise.all([
              standardSearchTool.execute(toolCallId, params),
              searchHebbian(hebbianCfg.endpoint, query, hebbianCfg.maxResults).catch(
                (err: unknown) => {
                  api.logger.warn(
                    `Hebbian search failed, returning core results only: ${err instanceof Error ? err.message : String(err)}`,
                  );
                  return [] as HebbianSearchResult[];
                },
              ),
            ]);

            // If Hebbian returned nothing, pass through the standard result as-is.
            if (hebbianHits.length === 0) {
              return standardResult;
            }

            // Fetch full node content for each Hebbian hit (in parallel).
            const nodeDetails = await Promise.all(
              hebbianHits.map((hit: HebbianSearchResult) =>
                getHebbianNode(hebbianCfg.endpoint, hit.id).catch(() => null),
              ),
            );

            // Convert to MemorySearchResult-compatible objects.
            const hebbianMemoryResults: Array<{
              path: string;
              startLine: number;
              endLine: number;
              score: number;
              snippet: string;
              source: "memory";
            }> = [];
            for (let i = 0; i < hebbianHits.length; i++) {
              const detail = nodeDetails[i];
              if (!detail) {
                continue;
              }
              hebbianMemoryResults.push({
                path: `hebbian://${hebbianHits[i].id}`,
                startLine: 0,
                endLine: 0,
                score: hebbianHits[i].score,
                snippet: detail.content,
                source: "memory",
              });
            }

            // Fire-and-forget: Hebbian learning — strengthen coaccessed edges.
            const nodeIds = hebbianHits.map((h: HebbianSearchResult) => h.id);
            strengthenCoaccessed(hebbianCfg.endpoint, nodeIds, hebbianCfg.strengthenAmount);

            // Extract the standard results payload from the tool output.
            const standardPayload = (standardResult as { details?: Record<string, unknown> })
              ?.details;
            const standardResults = (standardPayload?.results ?? []) as Array<{
              path?: string;
              score?: number;
              [k: string]: unknown;
            }>;

            // Merge, deduplicate by path, sort by score descending.
            const merged = [...standardResults, ...hebbianMemoryResults];
            const seen = new Set<string>();
            const deduped = merged.filter((r) => {
              const path = r.path ?? "";
              if (seen.has(path)) {
                return false;
              }
              seen.add(path);
              return true;
            });
            deduped.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));

            return jsonResult({
              results: deduped,
              provider: standardPayload?.provider,
              model: standardPayload?.model,
              fallback: standardPayload?.fallback,
              citations: standardPayload?.citations,
              hebbian: {
                augmented: true,
                hebbianResultCount: hebbianMemoryResults.length,
              },
            });
          },
        };

        return [augmentedSearchTool, memoryGetTool];
      },
      { names: ["memory_search", "memory_get"] },
    );

    // CLI commands are registered by memory-core; no need to duplicate here.
  },
};

export default memoryHebbianPlugin;
