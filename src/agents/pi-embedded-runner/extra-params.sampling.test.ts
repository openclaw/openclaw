import type { StreamFn } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiAiStreamSimpleMock } from "../../../test/helpers/agents/pi-ai-stream-simple-mock.js";
import {
  testing as extraParamsTesting,
  applyExtraParamsToAgent,
  resolveExtraParams,
  resolvePreparedExtraParams,
} from "./extra-params.js";

vi.mock("./logger.js", () => ({
  log: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../plugin-sdk/provider-stream-shared.js", () => ({
  createDeepSeekV4OpenAICompatibleThinkingWrapper: ({
    baseStreamFn,
  }: {
    baseStreamFn?: StreamFn;
  }) => baseStreamFn,
  createThinkingOnlyFinalTextWrapper: ({ baseStreamFn }: { baseStreamFn?: StreamFn }) =>
    baseStreamFn,
}));

vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  prepareProviderExtraParams: () => undefined,
  resolveProviderExtraParamsForTransport: () => undefined,
  wrapProviderStreamFn: () => undefined,
}));

vi.mock("../model-selection-normalize.js", () => ({
  legacyModelKey: (provider: string, model: string) => {
    const rawKey = `${provider.trim()}/${model.trim()}`;
    const canonicalKey = rawKey.toLowerCase();
    return rawKey === canonicalKey ? null : rawKey;
  },
  modelKey: (provider: string, model: string) => `${provider.trim()}/${model.trim()}`.toLowerCase(),
}));

vi.mock("../provider-request-config.js", () => ({
  resolveProviderRequestPolicyConfig: () => ({
    capabilities: {
      usesKnownNativeOpenAIRoute: true,
    },
  }),
}));

vi.mock("./google-stream-wrappers.js", () => ({
  createGoogleThinkingPayloadWrapper: (streamFn: StreamFn | undefined) => streamFn,
}));

vi.mock("./minimax-stream-wrappers.js", () => ({
  createMinimaxThinkingDisabledWrapper: (streamFn: StreamFn | undefined) => streamFn,
}));

vi.mock("./moonshot-stream-wrappers.js", () => ({
  createSiliconFlowThinkingWrapper: (streamFn: StreamFn | undefined) => streamFn,
  shouldApplySiliconFlowThinkingOffCompat: () => false,
}));

vi.mock("./openai-stream-wrappers.js", () => ({
  createOpenAICompletionsStrictMessageKeysWrapper: (streamFn: StreamFn | undefined) => streamFn,
  createOpenAICompletionsToolsCompatWrapper: (streamFn: StreamFn | undefined) => streamFn,
  createOpenAIResponsesContextManagementWrapper: (streamFn: StreamFn | undefined) => streamFn,
  createOpenAIStringContentWrapper: (streamFn: StreamFn | undefined) => streamFn,
}));

vi.mock("./prompt-cache-retention.js", () => ({
  resolveCacheRetention: () => undefined,
}));

vi.mock("./proxy-stream-wrappers.js", () => ({
  createOpenRouterSystemCacheWrapper: (streamFn: StreamFn | undefined) => streamFn,
}));

vi.mock("@earendil-works/pi-ai", () => createPiAiStreamSimpleMock());

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

describe("createStreamFnWithExtraParams sampling overrides", () => {
  it("forwards temperature, top_p, and maxTokens from override into the underlying streamFn options", () => {
    const underlying = vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn(async () => undefined),
      [Symbol.asyncIterator]: vi.fn(async function* () {
        // empty stream
      }),
    })) as unknown as StreamFn;
    const agent: { streamFn?: StreamFn } = { streamFn: underlying };

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5.4", {
      temperature: 0.4,
      topP: 0.7,
      maxTokens: 512,
    });

    if (!agent.streamFn) {
      throw new Error("expected extra params to wrap streamFn");
    }

    void agent.streamFn(
      { id: "gpt-5.4", api: "openai-completions", provider: "openai" } as never,
      { messages: [], tools: [] } as never,
      undefined,
    );

    expect(underlying).toHaveBeenCalledTimes(1);
    const callOptions = (underlying as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[2] as { temperature?: number; topP?: number; maxTokens?: number } | undefined;
    expect(callOptions?.temperature).toBe(0.4);
    expect(callOptions?.topP).toBe(0.7);
    expect(callOptions?.maxTokens).toBe(512);
  });

  it("forwards OpenAI completions token aliases into the underlying streamFn options", () => {
    const underlying = vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn(async () => undefined),
      [Symbol.asyncIterator]: vi.fn(async function* () {
        // empty stream
      }),
    })) as unknown as StreamFn;
    const agent: { streamFn?: StreamFn } = { streamFn: underlying };

    applyExtraParamsToAgent(agent, undefined, "dashscope", "kimi-k2.6", {
      max_completion_tokens: 64_000,
    });

    if (!agent.streamFn) {
      throw new Error("expected extra params to wrap streamFn");
    }

    void agent.streamFn(
      { id: "kimi-k2.6", api: "openai-completions", provider: "dashscope" } as never,
      { messages: [], tools: [] } as never,
      undefined,
    );

    const callOptions = (underlying as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[2] as { maxTokens?: number } | undefined;
    expect(callOptions?.maxTokens).toBe(64_000);
  });

  it("clamps configured maxTokens to the remaining model context window", () => {
    const underlying = vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn(async () => undefined),
      [Symbol.asyncIterator]: vi.fn(async function* () {
        // empty stream
      }),
    })) as unknown as StreamFn;
    const agent: { streamFn?: StreamFn } = { streamFn: underlying };

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5.4", {
      maxTokens: 90,
    });

    if (!agent.streamFn) {
      throw new Error("expected extra params to wrap streamFn");
    }

    void agent.streamFn(
      {
        id: "gpt-5.4",
        api: "openai-completions",
        provider: "openai",
        contextWindow: 100,
      } as never,
      {
        messages: [{ role: "user", content: "x".repeat(200), timestamp: 0 }],
        tools: [],
      } as never,
      undefined,
    );

    const callOptions = (underlying as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[2] as { maxTokens?: number } | undefined;
    expect(callOptions?.maxTokens).toBe(40);
  });

  it("keeps a smaller runtime maxTokens override when it fits the remaining context", () => {
    const underlying = vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn(async () => undefined),
      [Symbol.asyncIterator]: vi.fn(async function* () {
        // empty stream
      }),
    })) as unknown as StreamFn;
    const agent: { streamFn?: StreamFn } = { streamFn: underlying };

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5.4", {
      maxTokens: 90,
    });

    if (!agent.streamFn) {
      throw new Error("expected extra params to wrap streamFn");
    }

    void agent.streamFn(
      {
        id: "gpt-5.4",
        api: "openai-completions",
        provider: "openai",
        contextWindow: 100,
      } as never,
      {
        messages: [{ role: "user", content: "x".repeat(200), timestamp: 0 }],
        tools: [],
      } as never,
      { maxTokens: 30 } as never,
    );

    const callOptions = (underlying as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[2] as { maxTokens?: number } | undefined;
    expect(callOptions?.maxTokens).toBe(30);
  });

  it("clamps model maxTokens to the remaining context window", () => {
    const underlying = vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn(async () => undefined),
      [Symbol.asyncIterator]: vi.fn(async function* () {
        // empty stream
      }),
    })) as unknown as StreamFn;
    const agent: { streamFn?: StreamFn } = { streamFn: underlying };
    const model = {
      id: "mimo-v2-omni",
      api: "anthropic-messages",
      provider: "xiaomi-token-plan-cn",
      contextWindow: 100,
      maxTokens: 90,
    };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "xiaomi-token-plan-cn",
      "mimo-v2-omni",
      undefined,
      undefined,
      undefined,
      undefined,
      model as never,
    );

    if (!agent.streamFn) {
      throw new Error("expected extra params to wrap streamFn");
    }

    void agent.streamFn(
      model as never,
      {
        messages: [{ role: "user", content: "x".repeat(200), timestamp: 0 }],
        tools: [],
      } as never,
      undefined,
    );

    const callModel = (underlying as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[0] as { maxTokens?: number } | undefined;
    expect(callModel?.maxTokens).toBe(40);
  });

  it("keeps runtime maxTokens ahead of OpenAI completions token alias defaults", () => {
    const underlying = vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn(async () => undefined),
      [Symbol.asyncIterator]: vi.fn(async function* () {
        // empty stream
      }),
    })) as unknown as StreamFn;
    const agent: { streamFn?: StreamFn } = { streamFn: underlying };

    applyExtraParamsToAgent(agent, undefined, "dashscope", "kimi-k2.6", {
      max_completion_tokens: 64_000,
    });

    if (!agent.streamFn) {
      throw new Error("expected extra params to wrap streamFn");
    }

    void agent.streamFn(
      { id: "kimi-k2.6", api: "openai-completions", provider: "dashscope" } as never,
      { messages: [], tools: [] } as never,
      { maxTokens: 32_000 } as never,
    );

    const callOptions = (underlying as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[2] as { maxTokens?: number } | undefined;
    expect(callOptions?.maxTokens).toBe(32_000);
  });

  it("canonicalizes token aliases with config precedence before preparing stream params", () => {
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
          list: [
            {
              id: "bot",
              params: {
                max_tokens: 48_000,
              },
            },
          ],
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

  it("lets runtime options override the wrapper sampling defaults", () => {
    const underlying = vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn(async () => undefined),
      [Symbol.asyncIterator]: vi.fn(async function* () {
        // empty stream
      }),
    })) as unknown as StreamFn;
    const agent: { streamFn?: StreamFn } = { streamFn: underlying };

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5.4", { temperature: 0.4, topP: 0.7 });

    if (!agent.streamFn) {
      throw new Error("expected extra params to wrap streamFn");
    }

    void agent.streamFn(
      { id: "gpt-5.4", api: "openai-completions", provider: "openai" } as never,
      { messages: [], tools: [] } as never,
      { topP: 0.9 } as never,
    );

    const callOptions = (underlying as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[2] as { temperature?: number; topP?: number } | undefined;
    expect(callOptions?.temperature).toBe(0.4);
    expect(callOptions?.topP).toBe(0.9);
  });

  it("forwards response_format aliases into the underlying streamFn options", () => {
    const underlying = vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn(async () => undefined),
      [Symbol.asyncIterator]: vi.fn(async function* () {
        // empty stream
      }),
    })) as unknown as StreamFn;
    const agent: { streamFn?: StreamFn } = { streamFn: underlying };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "openai",
      "gpt-5.4",
      {
        response_format: { type: "json_object" },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { preparedExtraParams: { temperature: 0.4 } },
    );

    if (!agent.streamFn) {
      throw new Error("expected extra params to wrap streamFn");
    }

    void agent.streamFn(
      { id: "gpt-5.4", api: "openai-completions", provider: "openai" } as never,
      { messages: [], tools: [] } as never,
      undefined,
    );

    const callOptions = (underlying as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[2] as
      | { responseFormat?: Record<string, unknown>; temperature?: number }
      | undefined;
    expect(callOptions?.responseFormat).toEqual({ type: "json_object" });
    expect(callOptions?.temperature).toBe(0.4);
  });

  it("lets request responseFormat override configured response_format", () => {
    const underlying = vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn(async () => undefined),
      [Symbol.asyncIterator]: vi.fn(async function* () {
        // empty stream
      }),
    })) as unknown as StreamFn;
    const agent: { streamFn?: StreamFn } = { streamFn: underlying };

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
        responseFormat: { type: "json_object" },
      },
    );

    if (!agent.streamFn) {
      throw new Error("expected extra params to wrap streamFn");
    }

    void agent.streamFn(
      { id: "gpt-5.4", api: "openai-completions", provider: "openai" } as never,
      { messages: [], tools: [] } as never,
      undefined,
    );

    const callOptions = (underlying as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[2] as { responseFormat?: Record<string, unknown> } | undefined;
    expect(callOptions?.responseFormat).toEqual({ type: "json_object" });
  });

  it("keeps request-scoped response_format out of prepared extra params cache", () => {
    const prepareProviderExtraParams = vi.fn((params) => ({
      ...params.context.extraParams,
      prepared: true,
    }));
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams,
      resolveProviderExtraParamsForTransport: () => undefined,
      wrapProviderStreamFn: () => undefined,
    });

    const cfg = { agents: { defaults: {} } } as never;
    const first = resolvePreparedExtraParams({
      cfg,
      provider: "openai",
      modelId: "gpt-5.4",
      extraParamsOverride: {
        temperature: 0.4,
        response_format: {
          type: "json_schema",
          json_schema: { name: "one", schema: { type: "object" } },
        },
      },
    });
    const second = resolvePreparedExtraParams({
      cfg,
      provider: "openai",
      modelId: "gpt-5.4",
      extraParamsOverride: {
        temperature: 0.4,
        response_format: {
          type: "json_schema",
          json_schema: { name: "two", schema: { type: "object" } },
        },
      },
    });

    expect(prepareProviderExtraParams).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first).not.toHaveProperty("response_format");
    expect(first).not.toHaveProperty("responseFormat");
    expect(first.temperature).toBe(0.4);
  });
});
