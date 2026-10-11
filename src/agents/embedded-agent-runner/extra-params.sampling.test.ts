// Coverage for sampling, token, and response-format extra parameter precedence.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmStreamSimpleMock } from "../../../test/helpers/agents/llm-stream-simple-mock.js";
import type { Model } from "../../llm/types.js";
import { applyExtraParamsToAgent, resolveExtraParams } from "./extra-params.js";
import { runExtraParamsCase, testing as extraParamsTesting } from "./extra-params.test-support.js";
import { resolveCacheRetention } from "./prompt-cache-retention.js";

vi.mock("./logger.js", () => ({
  // Sampling tests assert call options only; silence warning/debug output from
  // invalid or provider-specific extra params.
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

function captureStreamOptions(
  agent: { streamFn?: StreamFn },
  underlying: StreamFn,
  model: Parameters<StreamFn>[0],
  options: (NonNullable<Parameters<StreamFn>[2]> & { topP?: number }) | undefined,
) {
  if (!agent.streamFn) {
    throw new Error("expected extra params to wrap streamFn");
  }
  void agent.streamFn(model, { messages: [], tools: [] }, options);
  return vi.mocked(underlying).mock.calls[0]?.[2];
}

describe("createStreamFnWithExtraParams sampling overrides", () => {
  it("forwards temperature, topP, and maxTokens from override into the underlying streamFn options", () => {
    const { underlying, agent } = createStreamAgent();

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5.4", {
      temperature: 0.4,
      topP: 0.7,
      maxTokens: 512,
    });

    const callOptions = captureStreamOptions(
      agent,
      underlying,
      { id: "gpt-5.4", api: "openai-completions", provider: "openai" } as never,
      undefined,
    );

    expect(underlying).toHaveBeenCalledTimes(1);

    expect(callOptions).toMatchObject({ temperature: 0.4, topP: 0.7, maxTokens: 512 });
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
      const { underlying, agent } = createStreamAgent();
      applyExtraParamsToAgent(
        agent,
        { agents: { defaults: { models: { "local/model": { params } } } } },
        "local",
        "model",
        override,
      );
      const callOptions = captureStreamOptions(
        agent,
        underlying,
        { id: "model", api: "openai-completions", provider: "local" } as Model,
        options,
      );
      expect(callOptions).toMatchObject({ topP: expected });
    },
  );

  it.each([false, true])("forwards configured streaming=%s to the transport", (streaming) => {
    const { underlying, agent } = createStreamAgent();
    applyExtraParamsToAgent(
      agent,
      {
        agents: { defaults: { models: { "local/model": { params: { streaming } } } } },
      },
      "local",
      "model",
    );
    const callOptions = captureStreamOptions(
      agent,
      underlying,
      { id: "model", api: "openai-completions", provider: "local" } as Model,
      undefined,
    );
    expect(callOptions).toMatchObject({ streaming });
  });

  it("canonicalizes token aliases with config precedence before preparing stream params", () => {
    // Canonicalization happens before provider preparation so plugins receive a
    // single maxTokens field with agent-level precedence already applied.
    const resolved = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            params: {
              maxTokens: 32_000,
            },
            models: {
              "dashscope/kimi-k2.6": {
                params: {
                  max_completion_tokens: 64_000,
                },
              },
            },
          },
          entries: {
            bot: {
              params: {
                max_tokens: 48_000,
              },
            },
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
    const { underlying, agent } = createStreamAgent();

    const responseFormat = {
      type: "object",
      properties: { reply: { type: "string" } },
      required: ["reply"],
      additionalProperties: false,
    };
    applyExtraParamsToAgent(
      agent,
      {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  response_format: { type: "text" },
                },
              },
            },
          },
        },
      },
      "openai",
      "gpt-5.4",
      {
        responseFormat,
      },
    );

    const callOptions = captureStreamOptions(
      agent,
      underlying,
      { id: "gpt-5.4", api: "openai-completions", provider: "openai" } as never,
      undefined,
    );

    expect(callOptions?.responseFormat).toEqual(responseFormat);
  });

  it("forwards frequency_penalty, presence_penalty, and seed from override into stream options", () => {
    const { underlying, agent } = createStreamAgent();

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5.4", {
      frequencyPenalty: 0.8,
      presencePenalty: 0.3,
      seed: 12345,
    });

    const callOptions = captureStreamOptions(
      agent,
      underlying,
      { id: "gpt-5.4", api: "openai-completions", provider: "openai" } as never,
      undefined,
    );

    expect(underlying).toHaveBeenCalledTimes(1);

    expect(callOptions).toMatchObject({ frequencyPenalty: 0.8, presencePenalty: 0.3, seed: 12345 });
  });

  it("forwards stop sequences from override into stream options", () => {
    const { underlying, agent } = createStreamAgent();

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5.4", {
      stop: ["User:", "Assistant:"],
    });

    const callOptions = captureStreamOptions(
      agent,
      underlying,
      { id: "gpt-5.4", api: "openai-completions", provider: "openai" } as never,
      undefined,
    );

    expect(underlying).toHaveBeenCalledTimes(1);

    expect(callOptions?.stop).toEqual(["User:", "Assistant:"]);
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
    const callOptions = captureStreamOptions(
      agent,
      underlying,
      { id: "claude-sonnet-5", api: "anthropic-messages", provider: "anthropic" } as never,
      requestOptions,
    );

    expect(underlying).toHaveBeenCalledTimes(1);

    expect(callOptions?.cacheRetention).toBe("long");
  });
});

describe("cacheRetention default behavior", () => {
  it("leaves Model Studio retention unspecified without opting into cache keys", () => {
    const captured = runExtraParamsCase({
      model: {
        id: "qwen-plus",
        name: "Qwen Plus",
        api: "openai-completions",
        provider: "qwen",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
      },
      cfg: { agents: { defaults: { params: { temperature: 0.5, cacheRetention: undefined } } } },
      payload: {},
    });
    expect(captured.options?.cacheRetention).toBeUndefined();
  });

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
  // Common Gemini payload fixture: tests vary only config precedence and final
  // option shape.
  return runExtraParamsCase({
    ...(params?.cfg ? { cfg: params.cfg as never } : {}),
    applyProvider: "google",
    applyModelId: "gemini-2.5-pro",
    model: {
      api: "google-generative-ai",
      provider: "google",
      id: "gemini-2.5-pro",
    } as unknown as Model<"openai-completions">,
    payload: {
      contents: [],
    },
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
            params: {
              cached_content: "cachedContents/default-cache",
            },
            models: {
              "google/gemini-2.5-pro": {
                params: {
                  cachedContent: "cachedContents/model-cache",
                },
              },
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
