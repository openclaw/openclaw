import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { DecisionProviderV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import {
  resolveProviderHttpRequestConfig,
  resolveProviderTransportSsrFPolicy,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { encodeLiquidDecisionRequest, supportsLiquidDecisionBatch } from "./decision-codec.js";
import { executeLiquidDecision } from "./decision-execution.js";

const BASE_URL = "https://api.liquid.ai/decisions/v1";

function hasUnsupportedParams(context: DecisionProviderContextV2): boolean {
  const { config, agentId, model } = context;
  const agent = agentId ? resolveAgentConfig(config, agentId) : undefined;
  const modelRef = `liquid-ai/${model.id}`;
  // The native endpoint defines no generation or routing parameters. Never silently
  // discard an authored limit or privacy control inherited from another config layer.
  return [
    config.models?.providers?.["liquid-ai"]?.params,
    model.params,
    config.agents?.defaults?.params,
    config.agents?.defaults?.models?.[modelRef]?.params,
    agent?.models?.[modelRef]?.params,
    agent?.params,
  ].some((params) => Object.values(params ?? {}).some((value) => value !== undefined));
}

export function buildLiquidDecisionProvider(deps: {
  getImageMetadata: (buffer: Buffer) => Promise<{ width: number; height: number } | null>;
}): DecisionProviderV2 {
  return {
    id: "liquid-ai",
    contractVersion: 2,
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      if (
        !["d1", "d1-ultra"].includes(context.model.id) ||
        (context.reasoning !== undefined && context.reasoning !== "auto") ||
        hasUnsupportedParams(context) ||
        !supportsLiquidDecisionBatch(batch)
      ) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      if (!context.auth.apiKey && !context.model.headers) {
        return { status: "unavailable", reason: "credentials-unavailable" };
      }
      const body = encodeLiquidDecisionRequest(batch, context.model.id);
      if (body === undefined) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      return executeLiquidDecision(batch, {
        body,
        signal: context.signal,
        deadlineMonotonicMs: context.deadlineMonotonicMs,
        isAdmissible: context.isAdmissible,
        capabilities: context.model.inference?.decision,
        getImageMetadata: deps.getImageMetadata,
        // Resolve after image inspection, inside the executor's caught transport phase.
        prepareTransport: () => {
          const configured = context.config.models?.providers?.["liquid-ai"];
          const configuredRequest = configured?.request;
          // The host owns credential selection and auth overrides; do not resolve auth again.
          const request = sanitizeConfiguredModelProviderRequest(
            configuredRequest
              ? {
                  proxy: configuredRequest.proxy,
                  tls: configuredRequest.tls,
                  allowPrivateNetwork: configuredRequest.allowPrivateNetwork,
                }
              : undefined,
          );
          const requestConfig = resolveProviderHttpRequestConfig({
            provider: "liquid-ai",
            capability: "llm",
            transport: "http",
            baseUrl: context.model.baseUrl ?? configured?.baseUrl ?? BASE_URL,
            defaultBaseUrl: BASE_URL,
            defaultHeaders: {
              "Content-Type": "application/json",
              ...(context.auth.apiKey &&
              (!configuredRequest?.auth || configuredRequest.auth.mode === "provider-default")
                ? { Authorization: `Bearer ${context.auth.apiKey}` }
                : {}),
            },
            headers: context.model.headers,
            request,
          });
          const url = requestConfig.baseUrl.replace(/\/+$/u, "") + "/systemone";
          return {
            url,
            headers: requestConfig.headers,
            policy: resolveProviderTransportSsrFPolicy({
              baseUrl: requestConfig.baseUrl,
              url,
              allowPrivateNetwork: requestConfig.allowPrivateNetwork,
              trustConfiguredBaseUrlOrigin: configuredRequest?.allowPrivateNetwork !== false,
            }),
            dispatcherPolicy: requestConfig.dispatcherPolicy,
          };
        },
      });
    },
  };
}
