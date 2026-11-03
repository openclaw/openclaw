import { getModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import {
  encodeLiquidDecisionRequest,
  supportsLiquidDecisionBatch,
  executeLiquidDecision,
} from "openclaw/plugin-sdk/decisions-systemone-runtime";
import { resolveProviderHttpRequestConfig } from "openclaw/plugin-sdk/provider-http";
import { normalizeClawRouterRootUrl } from "./base-url.js";
import { fetchClawRouterCapabilityOffers } from "./capability-offers.js";
import { readLiquidDecisionOffer } from "./decision-offers.js";
import type { ClawRouterDecisionDependencies } from "./decision-provider.js";

function hasUnsupportedParams(context: DecisionProviderContextV2) {
  const { config, model, agentId } = context;
  const agent = agentId ? resolveAgentConfig(config, agentId) : undefined;
  const modelRef = `clawrouter/${model.id}`;
  return [
    config.models?.providers?.clawrouter?.params,
    model.params,
    config.agents?.defaults?.params,
    config.agents?.defaults?.models?.[modelRef]?.params,
    agent?.models?.[modelRef]?.params,
    agent?.params,
  ].some((params) => Object.values(params ?? {}).some((value) => value !== undefined));
}

export async function evaluateClawRouterLiquidDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
  deps?: ClawRouterDecisionDependencies,
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  if (
    !["liquid-ai/d1", "liquid-ai/d1-ultra"].includes(context.model.id) ||
    (context.reasoning !== undefined && context.reasoning !== "auto") ||
    hasUnsupportedParams(context) ||
    !supportsLiquidDecisionBatch(batch) ||
    (batch.state.type === "image" && !deps)
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  if (context.auth.mode !== "api-key" || !context.auth.apiKey) {
    return { status: "unavailable", reason: "credentials-unavailable" };
  }
  let authorityError: { error: unknown } | undefined;
  const assertActive = () => {
    context.signal.throwIfAborted();
    let admitted: boolean;
    try {
      admitted = context.isAdmissible();
    } catch (error) {
      authorityError = { error };
      throw error;
    }
    if (!admitted || performance.now() >= context.deadlineMonotonicMs) {
      throw new Error("ClawRouter decision is no longer admitted.");
    }
  };
  try {
    assertActive();
    const prepared = getModelProviderRequestTransport(context.model);
    const baseUrl = normalizeClawRouterRootUrl(context.model.baseUrl) + "/v1";
    const request = resolveProviderHttpRequestConfig({
      provider: "clawrouter",
      capability: "other",
      transport: "http",
      baseUrl,
      defaultBaseUrl: baseUrl,
      headers: context.model.headers,
      defaultHeaders: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(!prepared?.auth || prepared.auth.mode === "provider-default"
          ? { Authorization: `Bearer ${context.auth.apiKey}` }
          : {}),
      },
      request: prepared
        ? {
            proxy: prepared.proxy,
            tls: prepared.tls,
            allowPrivateNetwork: prepared.allowPrivateNetwork,
          }
        : undefined,
    });
    const offers = await fetchClawRouterCapabilityOffers({
      context: {
        ...request,
        trustConfiguredBaseUrlOrigin: false,
        ssrfPolicy: undefined,
      },
      signal: context.signal,
      timeoutMs: () => {
        assertActive();
        return context.deadlineMonotonicMs - performance.now();
      },
    });
    assertActive();
    const selected = offers
      .filter((offer) => offer.model?.id === context.model.id)
      .map(readLiquidDecisionOffer)
      .find((offer) => offer !== undefined);
    // Changed limits, question contracts or billing require a new prepared catalog.
    if (
      !selected ||
      JSON.stringify(selected.inference.decision) !==
        JSON.stringify(context.model.inference?.decision)
    ) {
      return { status: "unavailable", reason: "unsupported-input" };
    }
    const encoded = encodeLiquidDecisionRequest(batch, selected.upstream);
    if (!encoded) return { status: "unavailable", reason: "unsupported-input" };
    return await executeLiquidDecision(batch, {
      body:
        selected.offer.routeKind === "manifest"
          ? JSON.stringify({ body: JSON.parse(encoded) })
          : encoded,
      signal: context.signal,
      deadlineMonotonicMs: context.deadlineMonotonicMs,
      isAdmissible: () => {
        assertActive();
        return true;
      },
      capabilities: selected.inference.decision,
      getImageMetadata: deps?.getImageMetadata ?? (async () => null),
      prepareTransport: () => ({
        url: selected.offer.url,
        headers: request.headers,
        policy: { allowPrivateNetwork: request.allowPrivateNetwork },
        dispatcherPolicy: request.dispatcherPolicy,
      }),
    });
  } catch {
    context.signal.throwIfAborted();
    if (authorityError) throw authorityError.error;
    return { status: "unavailable", reason: "transport" };
  }
}
