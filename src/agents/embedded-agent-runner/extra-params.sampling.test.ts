import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmStreamSimpleMock } from "../../../test/helpers/agents/llm-stream-simple-mock.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { applyExtraParamsToAgent, resolveExtraParams } from "./extra-params.js";
import { runExtraParamsCase, testing as extraParamsTesting } from "./extra-params.test-support.js";
import { resolveCacheRetention } from "./prompt-cache-retention.js";

vi.mock("./logger.js", () => ({
  log: {
    isEnabled: () => false,
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../llm/stream.js", () => createLlmStreamSimpleMock());

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: () => undefined,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: () => undefined,
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

function createStreamAgent() {
  const underlying = vi.fn(() => ({
    push: vi.fn(),
    result: vi.fn(async () => undefined),
    [Symbol.asyncIterator]: vi.fn(async function* () {}),
  })) as unknown as StreamFn;
  const agent: { streamFn?: StreamFn } = { streamFn: underlying };
  return { underlying, agent };
}

function modelConfig(ref: string, params: Record<string, unknown>): OpenClawConfig {
  return { agents: { defaults: { models: { [ref]: { params } } } } };
}

function sample(
  override?: Record<string, unknown>,
  cfg?: OpenClawConfig,
  options?: NonNullable<Parameters<StreamFn>[2]> & { topP?: number },
  provider = "openai",
  id = "gpt-5.4",
) {
  const { underlying, agent } = createStreamAgent();
  applyExtraParamsToAgent(agent, cfg, provider, id, override);
  if (!agent.streamFn) {
    throw new Error("expected extra params to wrap streamFn");
  }
  void agent.streamFn(
    makeProviderModelFixture({ id, api: "openai-completions", provider, baseUrl: "" }),
    { messages: [], tools: [] },
    options,
  );
  expect(underlying).toHaveBeenCalledTimes(1);
  return vi.mocked(underlying).mock.calls[0]?.[2];
}

describe("createStreamFnWithExtraParams sampling overrides", () => {
  it.each([
    { temperature: 0.4, topP: 0.7, maxTokens: 512 },
    { frequencyPenalty: 0.8, presencePenalty: 0.3, seed: 12345 },
    { stop: ["User:", "Assistant:"] },
  ])("forwards request overrides to stream options: %j", (override) => {
    const expected = structuredClone(override);
    expect(sample(override)).toMatchObject(expected);
  });

  it.each([
    { params: { top_p: 0.3 }, override: undefined, options: undefined, expected: 0.3 },
    { params: { topP: 0.3 }, override: undefined, options: undefined, expected: 0.3 },
    { params: { top_p: 0 }, override: undefined, options: undefined, expected: 0 },
    { params: { topP: 0.7, top_p: 0.3 }, override: undefined, options: undefined, expected: 0.7 },
    { params: { top_p: 0.3 }, override: { topP: 0.8 }, options: undefined, expected: 0.8 },
    { params: { top_p: 0.3 }, override: undefined, options: { topP: 0.9 }, expected: 0.9 },
  ])(
    "projects configured nucleus sampling with request precedence: %j",
    ({ params, override, options, expected }) => {
      const callOptions = sample(
        override,
        modelConfig("local/model", params),
        options,
        "local",
        "model",
      );
      expect(callOptions).toMatchObject({ topP: expected });
    },
  );

  it.each([false, true])("forwards configured streaming=%s to the transport", (streaming) => {
    const callOptions = sample(
      undefined,
      modelConfig("local/model", { streaming }),
      undefined,
      "local",
      "model",
    );
    expect(callOptions).toMatchObject({ streaming });
  });

  it("canonicalizes token aliases with config precedence before preparing stream params", () => {
    const resolved = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            params: { maxTokens: 32_000 },
            models: {
              "dashscope/kimi-k2.6": { params: { max_completion_tokens: 64_000 } },
            },
          },
          entries: {
            bot: { params: { max_tokens: 48_000 } },
          },
        },
      } as never,
      provider: "dashscope",
      modelId: "kimi-k2.6",
      agentId: "bot",
    });

    expect(resolved?.maxTokens).toBe(48_000);
    expect(resolved).not.toHaveProperty("max_completion_tokens");
    expect(resolved).not.toHaveProperty("max_tokens");
  });

  it("threads a run-scoped responseFormat schema ahead of configured response_format", () => {
    const responseFormat = {
      type: "object",
      properties: { reply: { type: "string" } },
      required: ["reply"],
      additionalProperties: false,
    };
    const callOptions = sample(
      { responseFormat },
      modelConfig("openai/gpt-5.4", { response_format: { type: "text" } }),
    );

    expect(callOptions?.responseFormat).toEqual(responseFormat);
  });

  it("projects configured prompt cache TTL with request precedence and rejects invalid values", () => {
    const cfg = modelConfig("openai/gpt-5.4", { promptCacheTtl: "12h" });
    expect(sample(undefined, cfg)?.promptCacheTtl).toBe("12h");
    expect(sample(undefined, cfg, { promptCacheTtl: undefined })?.promptCacheTtl).toBe("12h");
    expect(sample(undefined, cfg, { promptCacheTtl: "30m" })?.promptCacheTtl).toBe("30m");
    expect(sample({ promptCacheTtl: "24h" })?.promptCacheTtl).toBeUndefined();
  });

  it("preserves configured cache retention with an own undefined request option", () => {
    const { underlying, agent } = createStreamAgent();

    applyExtraParamsToAgent(
      agent,
      undefined,
      "anthropic",
      "claude-sonnet-5",
      { cacheRetention: "long" },
      undefined,
      undefined,
      undefined,
      { supportsPromptCacheKey: true } as never,
    );

    const requestOptions = { cacheRetention: undefined };
    expect(requestOptions).toHaveProperty("cacheRetention");
    void agent.streamFn?.(
      { id: "claude-sonnet-5", api: "anthropic-messages", provider: "anthropic" } as never,
      { messages: [], tools: [] },
      requestOptions,
    );
    const callOptions = vi.mocked(underlying).mock.calls[0]?.[2];

    expect(underlying).toHaveBeenCalledTimes(1);

    expect(callOptions?.cacheRetention).toBe("long");
  });
});

describe("cacheRetention default behavior", () => {
  it("respects legacy cacheControlTtl config", () => {
    expect(resolveCacheRetention({ cacheControlTtl: "1h" }, "anthropic")).toBe("long");
  });

  it("defaults to 'short' for anthropic-vertex without explicit config", () => {
    expect(
      resolveCacheRetention(
        undefined,
        "anthropic-vertex",
        "anthropic-messages",
        "claude-sonnet-4-6",
      ),
    ).toBe("short");
  });
});

function runGoogleExtraParamsCase(params?: { cfg?: unknown }) {
  return runExtraParamsCase({
    ...(params?.cfg ? { cfg: params.cfg as never } : {}),
    applyProvider: "google",
    applyModelId: "gemini-2.5-pro",
    model: {
      api: "google-generative-ai",
      provider: "google",
      id: "gemini-2.5-pro",
    } as unknown as Model<"openai-completions">,
    payload: { contents: [] },
  });
}

describe("extra-params: Google thinking payload compatibility", () => {
  beforeEach(() => {
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: (params) => params.context.extraParams,
      resolveProviderExtraParamsForTransport: () => undefined,
      wrapProviderStreamFn: () => undefined,
    });
  });

  it("lets higher-precedence cachedContent override lower-precedence cached_content", () => {
    const { options } = runGoogleExtraParamsCase({
      cfg: {
        agents: {
          defaults: {
            params: { cached_content: "cachedContents/default-cache" },
            models: {
              "google/gemini-2.5-pro": { params: { cachedContent: "cachedContents/model-cache" } },
            },
          },
        },
      },
    });

    expect((options as { cachedContent?: string } | undefined)?.cachedContent).toBe(
      "cachedContents/model-cache",
    );
  });
});
