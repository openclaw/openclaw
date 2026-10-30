import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { DecisionProviderV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import {
  fetchWithProviderHttpGuard,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  resolveProviderTransportSsrFPolicy,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import {
  decodeLiquidDecisionResult,
  encodeLiquidDecisionRequest,
  supportsLiquidDecisionBatch,
  supportsLiquidImageDimensions,
} from "./decision-codec.js";

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
      let release: (() => Promise<void>) | undefined;
      let admissionError: { error: unknown } | undefined;
      const assertActive = () => {
        context.signal.throwIfAborted();
        let admitted: boolean;
        try {
          admitted = context.isAdmissible();
        } catch (error) {
          admissionError = { error };
          throw error;
        }
        if (!admitted || performance.now() >= context.deadlineMonotonicMs) {
          throw new Error("Liquid Decision is no longer admitted.");
        }
      };
      try {
        assertActive();
        if (batch.state.type === "image") {
          const metadata = await deps.getImageMetadata(
            Buffer.from(batch.state.dataUri.split(",", 2)[1]!, "base64"),
          );
          assertActive();
          if (!supportsLiquidImageDimensions(metadata)) {
            return { status: "unavailable", reason: "unsupported-input" };
          }
        }
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
        assertActive();
        const guarded = await fetchWithProviderHttpGuard({
          url,
          init: { method: "POST", headers: requestConfig.headers, body },
          signal: context.signal,
          timeoutMs: context.deadlineMonotonicMs - performance.now(),
          beforeRequest: assertActive,
          policy: resolveProviderTransportSsrFPolicy({
            baseUrl: requestConfig.baseUrl,
            url,
            allowPrivateNetwork: requestConfig.allowPrivateNetwork,
            trustConfiguredBaseUrlOrigin: configuredRequest?.allowPrivateNetwork !== false,
          }),
          dispatcherPolicy: requestConfig.dispatcherPolicy,
          auditContext: "liquid-ai-decisions",
        });
        release = guarded.release;
        const response = guarded.response;
        if (!response.ok) {
          return {
            status: "unavailable",
            reason:
              response.status === 401 || response.status === 403
                ? "authentication"
                : response.status === 429
                  ? "rate-limited"
                  : [400, 413, 422].includes(response.status)
                    ? "unsupported-input"
                    : "transport",
          };
        }
        let value: unknown;
        try {
          value = await readProviderJsonResponse(response, "Liquid decisions", {
            maxBytes: 1_048_576,
            timeoutMs: Math.max(1, context.deadlineMonotonicMs - performance.now()),
          });
        } catch {
          context.signal.throwIfAborted();
          return { status: "unavailable", reason: "invalid-response" };
        }
        assertActive();
        return decodeLiquidDecisionResult(batch, value, context.model.inference?.decision);
      } catch {
        context.signal.throwIfAborted();
        if (admissionError) {
          throw admissionError.error;
        }
        return { status: "unavailable", reason: "transport" };
      } finally {
        await release?.();
      }
    },
  };
}
