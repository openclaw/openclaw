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
    wrapProviderStreamFn: ({ provider, context }) => {
      if (provider !== "openrouter") {
        return context.streamFn;
      }
      const thinkingLevel =
        context.modelId === "auto" || isProxyReasoningUnsupported(context.modelId)
          ? undefined
          : context.thinkingLevel;
      return createOpenRouterSystemCacheWrapper(
        createOpenRouterWrapper(context.streamFn, thinkingLevel, context.extraParams),
        context.extraParams,
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

  it.each([
    ["enabled", "openrouter/auto", "low", "high", { effort: "low" }],
    ["thinking off", "openrouter/auto", "off", "high", undefined],
    ["unsupported x-ai (#32039)", "x-ai/grok-4.1-fast", "medium", "medium", undefined],
  ] as const)("normalizes reasoning for %s", (_name, modelId, thinkingLevel, effort, reasoning) => {
    const payload = runOpenRouter({
      modelId,
      thinkingLevel,
      payload: { reasoning_effort: effort },
    });
    expect(payload).not.toHaveProperty("reasoning_effort");
    if (reasoning) {
      expect(payload.reasoning).toEqual(reasoning);
    } else {
      expect(payload).not.toHaveProperty("reasoning");
    }
  });
});
