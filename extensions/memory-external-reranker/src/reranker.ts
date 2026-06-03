import type {
  MemoryRerankerPlugin,
  RerankParams,
  RerankResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-reranker";

type ProviderEntry = {
  baseUrl: string;
  apiKey?: string;
};

export type ExternalRerankerConfig = {
  model: string;
  modelFallbacks?: string[];
  endpointPath?: string;
  topN?: number;
  providers: Record<string, ProviderEntry>;
};

type CohereRerankResponse = {
  results: Array<{ index: number; relevance_score: number }>;
};

/**
 * External reranker plugin implementation.
 *
 * Calls a Cohere-compatible rerank endpoint (works with Cohere, Jina, Voyage AI,
 * llama.cpp /v1/rerank, etc.). Iterates model candidates in order and returns on
 * the first success; aggregates errors and throws only when all candidates fail.
 */
export class ExternalMmrReranker implements MemoryRerankerPlugin {
  readonly id = "memory-external-reranker";

  constructor(private readonly cfg: ExternalRerankerConfig) {
    // Validate topN
    if (cfg.topN !== undefined) {
      if (!Number.isInteger(cfg.topN) || cfg.topN < 1) {
        throw new Error(`topN must be a positive integer, got ${cfg.topN}`);
      }
    }
  }

  async rerank(params: RerankParams): Promise<RerankResult> {
    const { query, documents, limit } = params;
    const candidates = [this.cfg.model, ...(this.cfg.modelFallbacks ?? [])];
    const endpointPath = this.cfg.endpointPath ?? "/v1/rerank";
    const topN = this.cfg.topN ?? limit;

    const errors: Error[] = [];

    for (const candidate of candidates) {
      const slashIdx = candidate.indexOf("/");
      const providerId = slashIdx >= 0 ? candidate.slice(0, slashIdx) : candidate;
      const modelId = slashIdx >= 0 ? candidate.slice(slashIdx + 1) : candidate;
      const provider = this.cfg.providers[providerId];
      if (!provider) {
        errors.push(new Error(`unknown provider: ${providerId}`));
        continue;
      }
      const url = `${provider.baseUrl}${endpointPath}`;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
          },
          body: JSON.stringify({
            query,
            documents: documents.map((d) => d.content),
            top_n: topN,
            model: modelId,
          }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
        }

        const data = (await response.json()) as CohereRerankResponse;
        return data.results.map((r) => ({
          id: documents[r.index]?.id ?? String(r.index),
          score: r.relevance_score,
        }));
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // All candidates exhausted — report every failure.
    const detail = candidates
      .map((c, i) => `${c}: ${errors[i]?.message ?? "unknown error"}`)
      .join("; ");
    throw new Error(`All reranker candidates failed — ${detail}`);
  }
}
