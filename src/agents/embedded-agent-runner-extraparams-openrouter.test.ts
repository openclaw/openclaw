// Covers OpenRouter-specific extra-params payload and header behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "../llm/providers/stream-wrappers/proxy.js";
import { runExtraParamsPayloadCase } from "./embedded-agent-runner-extraparams.test-support.js";
import { applyExtraParamsToAgent } from "./embedded-agent-runner/extra-params.js";
import { testing as extraParamsTesting } from "./embedded-agent-runner/extra-params.test-support.js";

beforeEach(() => {
  // OpenRouter behavior is supplied through the provider-runtime seam so tests
  // exercise the same wrapper boundary as production.
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: ({ context }) => context.extraParams,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: (params) => {
      if (params.provider !== "openrouter") {
        return params.context.streamFn;
      }

      const providerRouting =
        params.context.extraParams?.provider != null &&
        typeof params.context.extraParams.provider === "object"
          ? (params.context.extraParams.provider as Record<string, unknown>)
          : undefined;
      let streamFn = params.context.streamFn;
      if (providerRouting) {
        const underlying = streamFn;
        streamFn = (model, context, options) =>
          (underlying as StreamFn)(
            {
              ...model,
              compat: { ...model.compat, openRouterRouting: providerRouting },
            },
            context,
            options,
          );
      }

      const skipReasoningInjection =
        params.context.modelId === "auto" || isProxyReasoningUnsupported(params.context.modelId);
      const thinkingLevel = skipReasoningInjection ? undefined : params.context.thinkingLevel;
      return createOpenRouterSystemCacheWrapper(
        createOpenRouterWrapper(streamFn, thinkingLevel, params.context.extraParams),
        params.context.extraParams,
      );
    },
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

const runOpenRouter = (params: Omit<Parameters<typeof runExtraParamsPayloadCase>[0], "provider">) =>
  runExtraParamsPayloadCase({ provider: "openrouter", ...params });

describe("applyExtraParamsToAgent OpenRouter reasoning", () => {
  it("honors narrower camelCase response cache params over wider snake_case aliases", () => {
    const calls: Array<{ headers?: NonNullable<Parameters<StreamFn>[2]>["headers"] }> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({ headers: options?.headers });
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      {
        agents: {
          defaults: {
            params: {
              response_cache: false,
              response_cache_ttl_seconds: 60,
              response_cache_clear: false,
            },
            models: {
              "openrouter/auto": {
                params: {
                  responseCache: true,
                  responseCacheTtlSeconds: 600,
                  responseCacheClear: true,
                },
              },
            },
          },
        },
      },
      "openrouter",
      "auto",
    );

    void agent.streamFn?.(
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "auto",
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(calls[0]?.headers).toMatchObject({
      "X-OpenRouter-Cache": "true",
      "X-OpenRouter-Cache-Clear": "true",
      "X-OpenRouter-Cache-TTL": "600",
    });
  });

  it("forwards Fusion plugin config through extraBody", () => {
    const plugins = [
      {
        id: "fusion",
        analysis_models: [
          "google/gemini-3.5-flash",
          "moonshotai/kimi-k2.6",
          "deepseek/deepseek-v4-pro",
        ],
        model: "google/gemini-3.5-flash",
      },
    ];
    const payload = runOpenRouter({
      modelId: "openrouter/fusion",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openrouter/openrouter/fusion": {
                params: { extraBody: { plugins } },
              },
            },
          },
        },
      },
      payload: { model: "openrouter/fusion" },
    });

    expect(payload).toEqual({ model: "openrouter/fusion", plugins });
  });

  it("injects reasoning.effort when thinkingLevel is non-off for OpenRouter", () => {
    const payload = runOpenRouter({
      modelId: "openrouter/auto",
      thinkingLevel: "low",
    });

    expect(payload.reasoning).toEqual({ effort: "low" });
  });

  it.each([
    ["thinking off", "openrouter/auto", "off", "high"],
    ["unsupported x-ai (#32039)", "x-ai/grok-4.1-fast", "medium", "medium"],
  ] as const)("omits both reasoning formats for %s", (_name, modelId, thinkingLevel, effort) => {
    const payload = runOpenRouter({
      modelId,
      thinkingLevel,
      payload: { reasoning_effort: effort },
    });
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("reasoning");
  });

  it("does not inject effort when payload already has reasoning.max_tokens", () => {
    const payload = runOpenRouter({
      modelId: "openrouter/auto",
      thinkingLevel: "low",
      payload: { reasoning: { max_tokens: 256 } },
    });

    expect(payload).toEqual({ reasoning: { max_tokens: 256 } });
  });
});
