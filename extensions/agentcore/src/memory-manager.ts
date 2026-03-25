import {
  BedrockAgentCoreClient,
  RetrieveMemoryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import type { AgentCoreRuntimeConfig } from "./types.js";

// Inlined from OC's src/memory/types.ts to avoid importing the repo src/ tree
// (bundled extensions must only use openclaw/plugin-sdk/<subpath>).
export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory";
};

export type MemoryProviderStatus = {
  backend: string;
  provider: string;
  model: string;
  custom?: Record<string, unknown>;
};

export type MemoryEmbeddingProbeResult = { ok: true } | { ok: false; error: string };

export interface MemorySearchManager {
  search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]>;
  readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }>;
  status(): MemoryProviderStatus;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorAvailability(): Promise<boolean>;
  close(): Promise<void>;
}

const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MIN_SCORE = 0.0;

export type AgentCoreMemoryManagerParams = {
  config: AgentCoreRuntimeConfig;
  /** Tenant namespace (e.g. "tenant_{userId}:{agentId}"). */
  namespace: string;
};

/**
 * MemorySearchManager backed by AgentCore Memory (RetrieveMemoryRecords).
 *
 * Replaces OC's built-in SQLite + embedding pipeline. AgentCore handles
 * embeddings and vector search server-side — no local embedding provider needed.
 */
export class AgentCoreMemoryManager implements MemorySearchManager {
  private readonly client: BedrockAgentCoreClient;
  private readonly config: AgentCoreRuntimeConfig;
  private readonly namespace: string;

  constructor(params: AgentCoreMemoryManagerParams) {
    this.config = params.config;
    this.namespace = params.namespace;
    this.client = new BedrockAgentCoreClient({
      region: params.config.region,
      ...(params.config.endpoint ? { endpoint: params.config.endpoint } : {}),
    });
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;
    const minScore = opts?.minScore ?? DEFAULT_MIN_SCORE;

    const resp = await this.client.send(
      new RetrieveMemoryRecordsCommand({
        memoryId: this.config.memoryId,
        namespace: this.namespace,
        searchCriteria: {
          searchQuery: query,
          topK: maxResults,
        },
        maxResults,
      }),
    );

    const summaries = resp.memoryRecordSummaries;
    if (!summaries?.length) {
      return [];
    }

    return summaries
      .filter((_r, _i) => {
        // MemoryRecordSummary does not expose a score field; include all results.
        // Filtering by minScore is a no-op but kept for interface compatibility.
        return true;
      })
      .map((r, i) => ({
        path: `agentcore-memory://${this.namespace}/${r.memoryRecordId ?? `record-${i}`}`,
        startLine: 0,
        endLine: 0,
        score: 1.0 - i * 0.01, // Synthetic score based on rank order
        snippet: r.content?.text ?? "",
        source: "memory" as const,
      }));
  }

  async readFile(_params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    // AgentCore Memory is not file-based. Return empty for memory_get calls.
    return { text: "", path: _params.relPath };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "builtin",
      provider: "agentcore",
      model: "agentcore-managed",
      custom: {
        memoryId: this.config.memoryId,
        namespace: this.namespace,
        region: this.config.region,
      },
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    // AgentCore manages embeddings server-side — always available if memoryId is set.
    if (!this.config.memoryId) {
      return { ok: false, error: "AgentCore memoryId not configured" };
    }
    return { ok: true };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return !!this.config.memoryId;
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}
