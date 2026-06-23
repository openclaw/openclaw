import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type {
  MemoryRerankerPlugin,
  RerankParams,
  RerankResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-reranker";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  fetchWithSsrFGuard,
  isPrivateOrLoopbackHost,
  mergeSsrFPolicies,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";

const log = createSubsystemLogger("memory/external-reranker");

export const DEFAULT_EXTERNAL_RERANKER_TIMEOUT_MS = 30_000;

/** Builds the SSRF policy for a reranker endpoint.
 * Only grants private-network access when the user explicitly opts in. When opted
 * in, access is scoped to the specific configured hostname via an allowlist so the
 * policy does not open the full private range.
 */
export function resolveRerankerNetworkPolicy(params: {
  baseUrl: string;
  allowPrivateNetwork?: boolean;
}): SsrFPolicy | undefined {
  if (!params.allowPrivateNetwork) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(params.baseUrl);
  } catch {
    return undefined;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    return undefined;
  }
  // Restrict access to the specific configured host only, not the full private range.
  return mergeSsrFPolicies(
    buildHostnameAllowlistPolicyFromSuffixAllowlist([hostname]),
    ssrfPolicyFromDangerouslyAllowPrivateNetwork(true),
  );
}

/** Returns true when the configured reranker baseUrl targets a loopback/private literal host. */
export function requiresRerankerPrivateNetworkOptIn(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  return isPrivateOrLoopbackHost(parsed.hostname);
}

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

/** Compact score distribution for debug logs: count plus highest/lowest score. */
function summarizeScores(items: Array<{ score: number }>): {
  count: number;
  topScore: number | null;
  bottomScore: number | null;
} {
  if (items.length === 0) {
    return { count: 0, topScore: null, bottomScore: null };
  }
  let top = items[0].score;
  let bottom = items[0].score;
  for (const item of items) {
    if (item.score > top) {
      top = item.score;
    }
    if (item.score < bottom) {
      bottom = item.score;
    }
  }
  return { count: items.length, topScore: top, bottomScore: bottom };
}

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
    const startedAt = Date.now();
    const providerId = this.cfg.provider;
    const candidates = [this.cfg.model, ...(this.cfg.modelFallbacks ?? [])];
    const endpointPath = this.cfg.endpointPath ?? "/v1/rerank";
    const topN = this.cfg.topN ?? limit;
    const requestTimeoutMs = resolveTimerTimeoutMs(DEFAULT_EXTERNAL_RERANKER_TIMEOUT_MS, 1);

    log.debug("external reranker start", {
      provider: providerId,
      model: this.cfg.model,
      fallbacks: this.cfg.modelFallbacks ?? [],
      topN,
      documents: documents.length,
    });

    const providerEntry = this.openclawConfig.models?.providers?.[providerId];
    if (!providerEntry) {
      throw new Error(`no models.providers entry for provider: ${providerId}`);
    }
    if (
      requiresRerankerPrivateNetworkOptIn(providerEntry.baseUrl) &&
      providerEntry.request?.allowPrivateNetwork !== true
    ) {
      throw new Error(
        `Provider ${providerId} baseUrl (${providerEntry.baseUrl}) targets a private or loopback host. Set models.providers.${providerId}.request.allowPrivateNetwork=true to opt in.`,
      );
    }
    const { value: apiKey, unresolvedRefReason } = await resolveConfiguredSecretInputString({
      config: this.openclawConfig,
      env: process.env,
      value: providerEntry.apiKey,
      path: `models.providers.${providerId}.apiKey`,
    });
    if (unresolvedRefReason) {
      throw new Error(
        `[memory-external-reranker] API key SecretRef for provider ${providerId} could not be resolved: ${unresolvedRefReason}`,
      );
    }
    const ssrfPolicy = resolveRerankerNetworkPolicy({
      baseUrl: providerEntry.baseUrl,
      allowPrivateNetwork: providerEntry.request?.allowPrivateNetwork,
    });
    const errors: Error[] = [];

    const normalizedBase = providerEntry.baseUrl.replace(/\/+$/, "");
    const normalizedPath = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;

    for (const modelId of candidates) {
      const candidate = `${providerId}/${modelId}`;
      const url = `${normalizedBase}${normalizedPath}`;
      log.debug("external reranker candidate", {
        candidate,
        model: modelId,
        url,
        topN,
        documents: documents.length,
      });
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
          policy: ssrfPolicy,
          auditContext: "memory-external-reranker",
        });

        log.debug("external reranker response", {
          candidate,
          status: response.status,
          ok: response.ok,
        });

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
        log.debug("external reranker candidate success", {
          candidate,
          documents: documents.length,
          reranked: results.length,
          filtered: documents.length - results.length,
          scores: summarizeScores(results),
        });
        log.debug("external reranker elapsed", {
          candidate,
          elapsedMs: Date.now() - startedAt,
          documents: documents.length,
          reranked: results.length,
        });
        return results;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.debug("external reranker candidate failed", { candidate, error: error.message });
        errors.push(error);
      }
    }

    // All candidates exhausted — report every failure.
    const detail = candidates
      .map((c, i) => `${c}: ${errors[i]?.message ?? "unknown error"}`)
      .join("; ");
    log.debug("external reranker elapsed", {
      elapsedMs: Date.now() - startedAt,
      documents: documents.length,
      failed: true,
    });
    throw new Error(`All reranker candidates failed — ${detail}`);
  }
}
