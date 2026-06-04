import type {
  MemoryRerankerPlugin,
  RerankParams,
  RerankResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-reranker";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
} from "openclaw/plugin-sdk/ssrf-runtime";

export const DEFAULT_EXTERNAL_RERANKER_TIMEOUT_MS = 30_000;

let rerankerFetchGuard = fetchWithSsrFGuard;

export function setExternalRerankerFetchGuardForTesting(
  impl: typeof fetchWithSsrFGuard | null,
): void {
  rerankerFetchGuard = impl ?? fetchWithSsrFGuard;
}

export type ExternalRerankerConfig = {
  /** Provider ID — must match a key in `models.providers` in the OpenClaw config. */
  provider: string;
  /** Model ID sent in the rerank request body. */
  model: string;
  /** Additional model IDs (on the same provider) tried in order on failure. */
  modelFallbacks?: string[];
  endpointPath?: string;
  topN?: number;
  /**
   * Extra fields merged into the rerank request body verbatim.
   * Useful for provider-specific parameters (e.g. `max_chunks_per_doc` for Cohere,
   * `truncation` for Voyage AI) without requiring code changes.
   */
  additionalBodyParams?: Record<string, unknown>;
};

type CohereRerankResponse = {
  results: Array<{ index: number; relevance_score: number }>;
};

/**
 * External reranker plugin implementation.
 *
 * Calls a Cohere-compatible rerank endpoint (works with Cohere, Jina, Voyage AI,
 * llama.cpp /v1/rerank, etc.). The provider ID is the first segment of the model
 * string (before the first "/") and must match an entry in `models.providers` in
 * the OpenClaw config. Credentials may be set via `models.providers.<id>.apiKey`
 * using any standard SecretInput format (env ref, file, exec, or plain string).
 *
 * Iterates model candidates in order and returns on the first success; aggregates
 * errors and throws only when all candidates fail.
 */
export class ExternalMmrReranker implements MemoryRerankerPlugin {
  readonly id = "memory-external-reranker";

  constructor(
    private readonly cfg: ExternalRerankerConfig,
    private readonly openclawConfig: OpenClawConfig,
  ) {
    // Validate topN
    if (cfg.topN !== undefined) {
      if (!Number.isInteger(cfg.topN) || cfg.topN < 1) {
        throw new Error(`topN must be a positive integer, got ${cfg.topN}`);
      }
    }
  }

  async rerank(params: RerankParams): Promise<RerankResult> {
    const { query, documents, limit } = params;
    const providerId = this.cfg.provider;
    const candidates = [this.cfg.model, ...(this.cfg.modelFallbacks ?? [])];
    const endpointPath = this.cfg.endpointPath ?? "/v1/rerank";
    const topN = this.cfg.topN ?? limit;
    const requestTimeoutMs = resolveTimerTimeoutMs(DEFAULT_EXTERNAL_RERANKER_TIMEOUT_MS, 1);

    console.debug(
      `[memory-external-reranker] reranking with provider=${providerId} model=${this.cfg.model} fallbacks=${this.cfg.modelFallbacks?.join(",") ?? "none"} topN=${topN} documents=${documents.length}`,
    );

    const providerEntry = this.openclawConfig.models?.providers?.[providerId];
    if (!providerEntry) {
      throw new Error(`no models.providers entry for provider: ${providerId}`);
    }
    const { value: apiKey } = await resolveConfiguredSecretInputString({
      config: this.openclawConfig,
      env: process.env,
      value: providerEntry.apiKey,
      path: `models.providers.${providerId}.apiKey`,
    });
    const errors: Error[] = [];

    for (const modelId of candidates) {
      const candidate = `${providerId}/${modelId}`;
      const url = `${providerEntry.baseUrl}${endpointPath}`;
      console.debug(
        `[memory-external-reranker] candidate=${candidate} model=${modelId} url=${url} topN=${topN} documents=${documents.length}`,
      );
      try {
        const { response, release } = await rerankerFetchGuard({
          url,
          init: {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
              query,
              documents: documents.map((d) => d.content),
              top_n: topN,
              model: modelId,
              ...this.cfg.additionalBodyParams,
            }),
          },
          timeoutMs: requestTimeoutMs,
          policy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(true),
          auditContext: "memory-external-reranker",
        });

        console.debug(
          `[memory-external-reranker] candidate=${candidate} response status=${response.status} ok=${response.ok}`,
        );

        let results: RerankResult;
        try {
          if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
          }

          const data = (await response.json()) as CohereRerankResponse;
          results = data.results.map((r) => ({
            id: documents[r.index]?.id ?? String(r.index),
            score: r.relevance_score,
          }));
        } finally {
          await release();
        }
        console.debug(
          `[memory-external-reranker] candidate=${candidate} success: ${results.length} documents reranked`,
        );
        return results;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.debug(`[memory-external-reranker] candidate=${candidate} failed: ${error.message}`);
        errors.push(error);
      }
    }

    // All candidates exhausted — report every failure.
    const detail = candidates
      .map((c, i) => `${c}: ${errors[i]?.message ?? "unknown error"}`)
      .join("; ");
    throw new Error(`All reranker candidates failed — ${detail}`);
  }
}
