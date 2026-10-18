import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
} from "../llm/providers/stream-wrappers/proxy.js";
import { runExtraParamsPayloadCase } from "./embedded-agent-runner-extraparams.test-support.js";
import { applyExtraParamsToAgent } from "./embedded-agent-runner/extra-params.js";
import { testing as extraParamsTesting } from "./embedded-agent-runner/extra-params.test-support.js";

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: ({ context }) => context.extraParams,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: (params) => {
      if (params.provider !== "openrouter") {
        return params.context.streamFn;
      }

      // This fixture only exercises auto routing, which does not inject reasoning.
      return createOpenRouterSystemCacheWrapper(
        createOpenRouterWrapper(params.context.streamFn, undefined, params.context.extraParams),
        params.context.extraParams,
      );
    },
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

it("honors narrower camelCase response cache params over wider snake_case aliases", () => {
  const calls: Array<Parameters<StreamFn>[2]> = [];
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    calls.push(options);
    return {} as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };

  const config = {
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
  };
  applyExtraParamsToAgent(agent, config, "openrouter", "auto");

  void agent.streamFn?.(
    { api: "openai-completions", provider: "openrouter", id: "auto" } as never,
    { messages: [] } as never,
    {},
  );

  expect(calls[0]?.headers).toMatchObject({
    "X-OpenRouter-Cache": "true",
    "X-OpenRouter-Cache-Clear": "true",
    "X-OpenRouter-Cache-TTL": "600",
  });

  it("forwards Fusion plugin config through extraBody", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "openrouter",
      modelId: "openrouter/fusion",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openrouter/openrouter/fusion": {
                params: {
                  extraBody: {
                    plugins: [
                      {
                        id: "fusion",
                        analysis_models: [
                          "google/gemini-3.5-flash",
                          "moonshotai/kimi-k2.6",
                          "deepseek/deepseek-v4-pro",
                        ],
                        model: "google/gemini-3.5-flash",
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      payload: { model: "openrouter/fusion" },
    });

    expect(payload).toEqual({
      model: "openrouter/fusion",
      plugins: [
        {
          id: "fusion",
          analysis_models: [
            "google/gemini-3.5-flash",
            "moonshotai/kimi-k2.6",
            "deepseek/deepseek-v4-pro",
          ],
          model: "google/gemini-3.5-flash",
        },
      ],
    });
  });

  it("injects reasoning.effort when thinkingLevel is non-off for OpenRouter", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "openrouter",
      modelId: "openrouter/auto",
      thinkingLevel: "low",
    });

    expect(payload.reasoning).toEqual({ effort: "low" });
  });

  it("removes legacy reasoning_effort and keeps reasoning unset when thinkingLevel is off", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "openrouter",
      modelId: "openrouter/auto",
      thinkingLevel: "off",
      payload: { reasoning_effort: "high" },
    });

    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("reasoning");
  });

  it("does not inject effort when payload already has reasoning.max_tokens", () => {
    // max_tokens and effort are mutually exclusive in OpenRouter reasoning
    // payloads; caller-provided max_tokens must stay intact.
    const payload = runExtraParamsPayloadCase({
      provider: "openrouter",
      modelId: "openrouter/auto",
      thinkingLevel: "low",
      payload: { reasoning: { max_tokens: 256 } },
    });

    expect(payload).toEqual({ reasoning: { max_tokens: 256 } });
  });

  it("does not inject reasoning.effort for x-ai/grok models on OpenRouter (#32039)", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "openrouter",
      modelId: "x-ai/grok-4.1-fast",
      thinkingLevel: "medium",
      payload: { reasoning_effort: "medium" },
    });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });
});
