import assert from "node:assert/strict";
// Covers extra-params stream wrapper composition across provider families.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model, SimpleStreamOptions } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  testing as extraParamsTesting,
  type WrapProviderStreamFnParams,
} from "./embedded-agent-runner/extra-params.test-support.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

vi.mock("../plugins/provider-hook-runtime.js", () => ({
  clearProviderRuntimePluginCacheForTest: vi.fn(),
  testing: {
    buildHookProviderCacheKey: () => "test-provider-hook-cache-key",
    clearProviderRuntimePluginCacheForTest: vi.fn(),
  },
  ensureProviderRuntimePluginHandle: vi.fn(),
  getModelProviderRuntimePluginHandle: () => undefined,
}));

function firstTransportHookCall(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const call = mock.mock.calls[0]?.[0];
  if (!call || typeof call !== "object" || Array.isArray(call)) {
    throw new Error("expected provider transport hook call");
  }
  return call as Record<string, unknown>;
}

import { isAnthropicFamilyCacheTtlEligible } from "../llm/providers/stream-wrappers/anthropic-family-cache-semantics.js";
import { createGoogleThinkingPayloadWrapper } from "../llm/providers/stream-wrappers/google.js";
import { createMinimaxFastModeWrapper } from "../llm/providers/stream-wrappers/minimax.js";
import {
  createCodexNativeWebSearchWrapper,
  createOpenAIAttributionHeadersWrapper,
  createOpenAICompletionsStrictMessageKeysWrapper,
  createOpenAIReasoningCompatibilityWrapper,
  createOpenAIResponsesContextManagementWrapper,
  createOpenAIStringContentWrapper,
  createOpenAITextVerbosityWrapper,
  createOpenAIThinkingLevelWrapper,
  resolveOpenAITextVerbosity,
} from "../llm/providers/stream-wrappers/openai.js";
import {
  applyExtraParamsToAgent,
  resolveAgentTransportOverride,
  resolveExplicitSettingsTransport,
  resolvePreparedExtraParams,
} from "./embedded-agent-runner/extra-params.js";
import { log } from "./embedded-agent-runner/logger.js";

function installFullProviderRuntimeDepsForTest() {
  // Install a test-only provider runtime that composes the same wrapper families
  // the production provider hook layer owns.
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: (params) => {
      if (params.provider !== "openai") {
        return undefined;
      }
      const transport = params.context.extraParams?.transport;
      if (transport === "auto" || transport === "sse" || transport === "websocket") {
        return params.context.extraParams;
      }
      return {
        ...params.context.extraParams,
        transport: "auto",
      };
    },
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: (params) => {
      if (params.provider === "openai") {
        return createTestOpenAIProviderWrapper(params);
      }
      if (params.provider === "azure-openai" || params.provider === "azure-openai-responses") {
        return createTestOpenAIProviderWrapper(params);
      }
      if (params.provider === "amazon-bedrock") {
        return isAnthropicFamilyCacheTtlEligible({
          provider: params.provider,
          modelId: params.context.modelId,
        })
          ? params.context.streamFn
          : createTestBedrockNoCacheWrapper(params.context.streamFn);
      }
      if (params.provider === "google") {
        return createGoogleThinkingPayloadWrapper(
          params.context.streamFn,
          params.context.thinkingLevel,
        );
      }
      if (params.provider === "kimi") {
        return params.context.streamFn;
      }
      if (params.provider === "minimax" || params.provider === "minimax-portal") {
        return createMinimaxFastModeWrapper(
          params.context.streamFn,
          params.context.extraParams?.fastMode === true,
        );
      }
      return params.context.streamFn;
    },
  });
}

function createTestBedrockNoCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? (() => ({}) as ReturnType<StreamFn>);
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      cacheRetention: "none",
    });
}

function withMinimalProviderRuntimeDepsForTest<T>(run: () => T): T {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: () => undefined,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: (params) => params.context.streamFn,
  });
  try {
    return run();
  } finally {
    installFullProviderRuntimeDepsForTest();
  }
}

function createTestOpenAIProviderWrapper(params: WrapProviderStreamFnParams): StreamFn {
  let streamFn = params.context.streamFn;
  streamFn = createOpenAIAttributionHeadersWrapper(streamFn);

  const textVerbosity = resolveOpenAITextVerbosity(params.context.extraParams);
  if (textVerbosity) {
    streamFn = createOpenAITextVerbosityWrapper(streamFn, textVerbosity);
  }

  streamFn = createCodexNativeWebSearchWrapper(streamFn, {
    config: params.context.config,
    agentDir: params.context.agentDir,
    agentId: params.context.agentId,
    nativeWebSearchAllowedByToolPolicy: params.context.nativeWebSearchAllowedByToolPolicy,
  });
  streamFn = createOpenAIStringContentWrapper(streamFn);
  streamFn = createOpenAICompletionsStrictMessageKeysWrapper(streamFn);
  return createOpenAIResponsesContextManagementWrapper(
    createOpenAIReasoningCompatibilityWrapper(
      createOpenAIThinkingLevelWrapper(streamFn, params.context.thinkingLevel),
    ),
    params.context.extraParams,
  );
}

beforeEach(() => {
  installFullProviderRuntimeDepsForTest();
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("applyExtraParamsToAgent", () => {
  function createOptionsCaptureAgent() {
    const calls: Array<SimpleStreamOptions | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options);
      return {} as ReturnType<StreamFn>;
    };
    return {
      calls,
      agent: { streamFn: baseStreamFn },
    };
  }

  function buildModelConfig(modelKey: string, params: Record<string, unknown>) {
    return {
      agents: {
        defaults: {
          models: {
            [modelKey]: { params },
          },
        },
      },
    };
  }

  type OpenAIResponsesWrapperOptions = SimpleStreamOptions & {
    replayResponsesItemIds?: boolean;
  };
  type OpenAIResponsesWrapperCompat = NonNullable<Model<"openai-responses">["compat"]> & {
    supportsStore?: boolean;
  };

  const buildResponsesWrapperModel = (params: {
    provider: string;
    id: string;
    baseUrl: string;
    compat?: OpenAIResponsesWrapperCompat;
  }): Model<"openai-responses"> => ({
    api: "openai-responses",
    provider: params.provider,
    id: params.id,
    name: params.id,
    baseUrl: params.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 4096,
    ...(params.compat ? { compat: params.compat } : {}),
  });

  const captureOpenAIResponsesWrapperReplay = (params: {
    model: Model<"openai-responses">;
    options?: OpenAIResponsesWrapperOptions;
  }): boolean | undefined => {
    let capturedOptions: OpenAIResponsesWrapperOptions | undefined;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      capturedOptions = options;
      return createAssistantMessageEventStream();
    };
    const streamFn = createOpenAIResponsesContextManagementWrapper(baseStreamFn, undefined);

    void streamFn(params.model, { messages: [] }, params.options);

    return capturedOptions?.replayResponsesItemIds;
  };

  it("passes agentDir and workspaceDir to provider stream wrappers", () => {
    let capturedContext: WrapProviderStreamFnParams["context"] | undefined;
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: () => undefined,
      wrapProviderStreamFn: (params) => {
        capturedContext = params.context;
        return params.context.streamFn;
      },
    });

    const agent = { streamFn: (() => ({}) as ReturnType<StreamFn>) as StreamFn };
    const model = {
      api: "openai-chatgpt-responses",
      provider: "openai",
      id: "gpt-5.4",
    } as Model<"openai-chatgpt-responses">;

    applyExtraParamsToAgent(
      agent,
      undefined,
      "openai",
      "gpt-5.4",
      undefined,
      "high",
      "cass",
      "/tmp/openclaw-workspace",
      model,
      "/tmp/openclaw-agent",
      undefined,
      {
        nativeWebSearchPolicyContext: {
          sessionKey: "agent:cass:main",
          sandboxToolPolicy: { deny: ["group:web"] },
          messageProvider: "teams",
          agentAccountId: "acct-1",
          groupId: "group-1",
          groupChannel: "General",
          groupSpace: "space-1",
          spawnedBy: "agent:cass:main",
          senderId: "alice",
          senderName: "Alice",
          senderUsername: "alice-user",
          senderE164: "+15551234567",
        },
      },
    );

    expect(capturedContext?.agentDir).toBe("/tmp/openclaw-agent");
    expect(capturedContext?.workspaceDir).toBe("/tmp/openclaw-workspace");
    expect(capturedContext?.nativeWebSearchAllowedByToolPolicy).toBe(false);
    expect("nativeWebSearchPolicyContext" in (capturedContext ?? {})).toBe(false);
  });

  function runResponsesPayloadMutationCase(params: {
    applyProvider: string;
    applyModelId: string;
    model:
      | Model<"openai-responses">
      | Model<"azure-openai-responses">
      | Model<"openai-chatgpt-responses">
      | Model<"openai-completions">
      | Model<"anthropic-messages">
      | Model<"google-generative-ai">;
    options?: SimpleStreamOptions;
    cfg?: Record<string, unknown>;
    extraParamsOverride?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    thinkingLevel?: Parameters<typeof applyExtraParamsToAgent>[5];
  }) {
    // Mutates a caller-owned payload through onPayload, matching how the runtime
    // finalizes provider request bodies.
    const payload = params.payload ?? { store: false };
    let calls = 0;
    const baseStreamFn: StreamFn = (model, _context, options) => {
      calls += 1;
      options?.onPayload?.(payload, model);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(
      agent,
      params.cfg as Parameters<typeof applyExtraParamsToAgent>[1],
      params.applyProvider,
      params.applyModelId,
      params.extraParamsOverride,
      params.thinkingLevel,
    );
    const context: Context = { messages: [] };
    void agent.streamFn?.(params.model, context, params.options ?? {});
    expect(calls).toBe(1);
    return payload;
  }

  function runParallelToolCallsPayloadMutationCase(
    params: Parameters<typeof runResponsesPayloadMutationCase>[0],
  ) {
    return withMinimalProviderRuntimeDepsForTest(() =>
      runResponsesPayloadMutationCase({ ...params, payload: params.payload ?? {} }),
    );
  }

  it("restores explicit MiniMax-M3 maxTokens when rewriting budget thinking", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "minimax",
      applyModelId: "MiniMax-M3",
      thinkingLevel: "adaptive",
      model: {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M3",
      } as Model<"anthropic-messages">,
      payload: { max_tokens: 8692, thinking: { type: "enabled", budget_tokens: 8192 } },
      options: { maxTokens: 500 },
    });
    expect(payload).toStrictEqual({ max_tokens: 500, thinking: { type: "adaptive" } });
  });

  it("fills DeepSeek V4 reasoning_content for unowned OpenAI-compatible proxy models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "opencode",
      applyModelId: "deepseek-v4-pro",
      thinkingLevel: "high",
      model: {
        api: "openai-completions",
        provider: "opencode",
        id: "deepseek-v4-pro",
      } as Model<"openai-completions">,
      payload: {
        messages: [
          { role: "user", content: "continue" },
          { role: "assistant", content: "I used a tool" },
          { role: "tool", content: "ok" },
        ],
      },
    });

    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.reasoning_effort).toBe("high");
    expect(messages[0]).not.toHaveProperty("reasoning_content");
    expect(messages[1]).toHaveProperty("reasoning_content", "");
    expect(messages[2]).not.toHaveProperty("reasoning_content");
  });

  it("does not add DeepSeek V4 thinking params on the Foundry fallback path", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "microsoft-foundry",
      applyModelId: "deepseek-v4-pro",
      thinkingLevel: "high",
      model: {
        api: "openai-completions",
        provider: "microsoft-foundry",
        id: "deepseek-v4-pro",
      } as Model<"openai-completions">,
      payload: {
        reasoning_effort: "high",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(payload.reasoning_effort).toBe("high");
    expect(payload).not.toHaveProperty("thinking");
  });

  it("fills MiMo V2.6 reasoning_content for unowned OpenAI-compatible proxy models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "opencode",
      applyModelId: "xiaomi/mimo-v2.6-flash",
      thinkingLevel: "high",
      model: {
        api: "openai-completions",
        provider: "opencode",
        id: "xiaomi/mimo-v2.6-flash",
      } as Model<"openai-completions">,
      payload: {
        messages: [
          { role: "user", content: "continue" },
          { role: "assistant", content: "I used a tool" },
          { role: "tool", content: "ok" },
        ],
      },
    });

    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.reasoning_effort).toBe("high");
    expect(messages[1]).toHaveProperty("reasoning_content", "");
  });

  it("promotes reasoning-only MiMo V2 proxy finals to visible text", async () => {
    const resultMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "proxy final answer" }],
      api: "openai-completions",
      provider: "opencode",
      model: "xiaomi/mimo-v2-pro",
      usage: createZeroUsageFixture(),
      stopReason: "stop",
      timestamp: 1,
    } as const;
    const baseStreamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message: resultMessage as never });
      });
      return stream;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(agent, undefined, "opencode", "xiaomi/mimo-v2-pro", undefined, "high");

    const model = {
      api: "openai-completions",
      provider: "opencode",
      id: "xiaomi/mimo-v2-pro",
    } as Model<"openai-completions">;
    const stream = await agent.streamFn?.(model, { messages: [] }, {});
    assert(stream, "expected stream function");
    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "done",
        reason: "stop",
        message: {
          ...resultMessage,
          content: [{ type: "text", text: "proxy final answer" }],
        },
      },
    ]);
    await expect(stream.result()).resolves.toMatchObject({
      content: [{ type: "text", text: "proxy final answer" }],
    });
  });

  it("strips disabled reasoning payloads for native OpenAI responses models that do not support none", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: {
        reasoning: { effort: "none", summary: "auto" },
      },
      thinkingLevel: "off",
    });

    expect(payload).toStrictEqual({
      context_management: [{ type: "compaction", compact_threshold: 80000 }],
      parallel_tool_calls: true,
      store: true,
      text: { verbosity: "low" },
    });
  });

  it.each([
    {
      name: "uses canonical model config keys for provider-prefixed model ids",
      applyProvider: "openrouter",
      applyModelId: "openrouter/auto",
      configKey: "openrouter/auto",
      params: { parallel_tool_calls: false },
      extraParamsOverride: undefined,
      model: {
        api: "openai-completions",
        provider: "openrouter",
        id: "openrouter/auto",
      } as Model<"openai-completions">,
      expected: false,
    },
    {
      name: "keeps legacy double-prefixed model config fallback for provider-prefixed model ids",
      applyProvider: "openrouter",
      applyModelId: "openrouter/auto",
      configKey: "openrouter/openrouter/auto",
      params: { parallel_tool_calls: false },
      extraParamsOverride: undefined,
      model: {
        api: "openai-completions",
        provider: "openrouter",
        id: "openrouter/auto",
      } as Model<"openai-completions">,
      expected: false,
    },
    {
      name: "injects parallel_tool_calls for openai-responses payloads when configured",
      applyProvider: "openai",
      applyModelId: "gpt-5",
      configKey: "openai/gpt-5",
      params: { parallelToolCalls: true },
      extraParamsOverride: undefined,
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      expected: true,
    },
    {
      name: "lets runtime override win across alias styles for parallel_tool_calls",
      applyProvider: "nvidia-nim",
      applyModelId: "moonshotai/kimi-k2.5",
      configKey: "nvidia-nim/moonshotai/kimi-k2.5",
      params: { parallel_tool_calls: true },
      extraParamsOverride: { parallelToolCalls: false },
      model: {
        api: "openai-completions",
        provider: "nvidia-nim",
        id: "moonshotai/kimi-k2.5",
      } as Model<"openai-completions">,
      expected: false,
    },
  ])(
    "$name",
    ({ applyProvider, applyModelId, configKey, params, extraParamsOverride, model, expected }) => {
      const payload = runParallelToolCallsPayloadMutationCase({
        applyProvider,
        applyModelId,
        cfg: buildModelConfig(configKey, params),
        extraParamsOverride,
        model,
      });

      expect(payload.parallel_tool_calls).toBe(expected);
    },
  );

  function createGoogleCompletionsModel(): Model<"openai-completions"> {
    return {
      api: "openai-completions",
      provider: "google",
      id: "gemini-2.5-pro",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    } as Model<"openai-completions">;
  }

  it("keeps store untouched for native openai-completions payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-4.1",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-4.1",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-completions">,
      payload: {
        messages: [],
        store: false,
      },
    });

    expect(payload.store).toBe(false);
  });

  it("merges extra_body into openai-completions payloads before proxy store stripping", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "google",
      applyModelId: "gemini-2.5-pro",
      cfg: buildModelConfig("google/gemini-2.5-pro", {
        chat_template_kwargs: { enable_thinking: true, template_only: true },
        extraBody: {
          google: { thinking_config: { thinking_budget: 0 } },
          chat_template_kwargs: { enable_thinking: false },
          store: false,
        },
      }),
      model: createGoogleCompletionsModel(),
      payload: {
        messages: [],
      },
    });

    expect(payload.google).toEqual({ thinking_config: { thinking_budget: 0 } });
    expect(payload.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(payload).not.toHaveProperty("store");
  });

  it("applies extra_body tuning-key overrides without warning", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const payload = runResponsesPayloadMutationCase({
        applyProvider: "deepseek",
        applyModelId: "deepseek-chat",
        extraParamsOverride: {
          extra_body: {
            thinking: { type: "disabled" },
          },
        },
        model: {
          api: "openai-completions",
          provider: "deepseek",
          id: "deepseek-chat",
          baseUrl: "https://api.deepseek.com/v1",
        } as Model<"openai-completions">,
        payload: {
          messages: [],
          model: "deepseek-chat",
          thinking: { type: "enabled" },
        },
      });

      expect(payload.thinking).toEqual({ type: "disabled" });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it.each<[string, unknown]>([["messages", [{ role: "user", content: "configured message" }]]])(
    "warns when extra_body overrides framework-managed %s",
    (key, value) => {
      const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
      try {
        const payload = runResponsesPayloadMutationCase({
          applyProvider: "deepseek",
          applyModelId: "deepseek-chat",
          extraParamsOverride: {
            extra_body: {
              [key]: value,
            },
          },
          model: {
            api: "openai-completions",
            provider: "deepseek",
            id: "deepseek-chat",
            baseUrl: "https://api.deepseek.com/v1",
          } as Model<"openai-completions">,
          payload: {
            messages: [],
            model: "deepseek-chat",
            stream: true,
          },
        });

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(`framework-managed request keys: ${key}`),
        );
        expect(payload[key]).toEqual(value);
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  it.each([
    {
      name: "warns and skips invalid chat_template_kwargs params",
      applyProvider: "vllm",
      applyModelId: "nemotron-3-super",
      configKey: "vllm/nemotron-3-super",
      params: { chat_template_kwargs: "not-an-object" },
      model: {
        api: "openai-completions",
        provider: "vllm",
        id: "nemotron-3-super",
        baseUrl: "http://127.0.0.1:8000/v1",
      } as Model<"openai-completions">,
      payload: { messages: [] },
      missingProperty: "chat_template_kwargs",
      warning: "ignoring invalid chat_template_kwargs param: not-an-object",
    },
    {
      name: "warns and skips invalid extra_body params",
      applyProvider: "google",
      applyModelId: "gemini-2.5-pro",
      configKey: "google/gemini-2.5-pro",
      params: { extra_body: "not-an-object" },
      model: createGoogleCompletionsModel(),
      payload: undefined,
      missingProperty: "extra_body",
      warning: "ignoring invalid extra_body param: not-an-object",
    },
  ])(
    "$name",
    ({
      applyProvider,
      applyModelId,
      configKey,
      params,
      model,
      payload: initialPayload,
      missingProperty,
      warning,
    }) => {
      const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
      try {
        const payload = runResponsesPayloadMutationCase({
          applyProvider,
          applyModelId,
          cfg: buildModelConfig(configKey, params),
          model,
          payload: initialPayload,
        });

        expect(payload).not.toHaveProperty(missingProperty);
        expect(warnSpy).toHaveBeenCalledWith(warning);
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  it.each([
    {
      name: "does not inject parallel_tool_calls for unsupported APIs",
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-6",
      cfg: buildModelConfig("anthropic/claude-sonnet-4-6", {
        parallel_tool_calls: false,
      }),
      extraParamsOverride: undefined,
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-6",
      } as Model<"anthropic-messages">,
    },
    {
      name: "lets null runtime override suppress inherited parallel_tool_calls injection",
      applyProvider: "nvidia-nim",
      applyModelId: "moonshotai/kimi-k2.5",
      cfg: buildModelConfig("nvidia-nim/moonshotai/kimi-k2.5", {
        parallel_tool_calls: true,
      }),
      extraParamsOverride: { parallelToolCalls: null },
      model: {
        api: "openai-completions",
        provider: "nvidia-nim",
        id: "moonshotai/kimi-k2.5",
      } as Model<"openai-completions">,
    },
  ])("$name", ({ applyProvider, applyModelId, cfg, extraParamsOverride, model }) => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyProvider,
      applyModelId,
      cfg,
      extraParamsOverride,
      model,
    });

    expect(payload).not.toHaveProperty("parallel_tool_calls");
  });

  it("warns and skips invalid parallel_tool_calls values", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runParallelToolCallsPayloadMutationCase({
        applyProvider: "nvidia-nim",
        applyModelId: "moonshotai/kimi-k2.5",
        cfg: buildModelConfig("nvidia-nim/moonshotai/kimi-k2.5", {
          parallelToolCalls: "false",
        }),
        model: {
          api: "openai-completions",
          provider: "nvidia-nim",
          id: "moonshotai/kimi-k2.5",
        } as Model<"openai-completions">,
      });

      expect(payload).not.toHaveProperty("parallel_tool_calls");
      expect(warnSpy).toHaveBeenCalledWith("ignoring invalid parallel_tool_calls param: false");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("normalizes thinking=off to null for SiliconFlow Pro models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "siliconflow",
      applyModelId: "Pro/MiniMaxAI/MiniMax-M2.7",
      model: {
        api: "openai-completions",
        provider: "siliconflow",
        id: "Pro/MiniMaxAI/MiniMax-M2.7",
      } as Model<"openai-completions">,
      payload: { thinking: "off" },
      thinkingLevel: "off",
    });
    expect(payload?.thinking).toBeNull();
  });

  it("sanitizes invalid Atproxy Gemini negative thinking budgets", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "atproxy",
      applyModelId: "gemini-3.1-pro-high",
      model: {
        api: "google-generative-ai",
        provider: "atproxy",
        id: "gemini-3.1-pro-high",
      } as Model<"google-generative-ai">,
      payload: {
        contents: [
          {
            role: "user",
            parts: [
              { text: "describe image" },
              {
                inlineData: {
                  mimeType: "image/png",
                  data: "ZmFrZQ==",
                },
              },
            ],
          },
        ],
        config: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: -1,
          },
        },
      },
      thinkingLevel: "high",
    });
    const thinkingConfig = (
      payload?.config as { thinkingConfig?: Record<string, unknown> } | undefined
    )?.thinkingConfig;
    expect(thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
    expect(
      (
        payload?.contents as
          | Array<{ parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> }>
          | undefined
      )?.[0]?.parts?.[1]?.inlineData,
    ).toEqual({
      mimeType: "image/png",
      data: "ZmFrZQ==",
    });
  });

  it("preserves Gemma 4 thinking off instead of rewriting thinkingBudget=0 to MINIMAL", () => {
    const payloads = [
      runResponsesPayloadMutationCase({
        applyProvider: "google",
        applyModelId: "gemma-4-26b-a4b-it",
        thinkingLevel: "off",
        model: {
          api: "google-generative-ai",
          provider: "google",
          id: "gemma-4-26b-a4b-it",
          reasoning: true,
        } as Model<"google-generative-ai">,
        payload: { config: { thinkingConfig: { thinkingBudget: 0 } } },
      }),
    ];

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.config).toStrictEqual({});
  });
  it.each([
    {
      name: "passes configured websocket transport through stream options",
      cfg: buildModelConfig("openai/gpt-5.4", { transport: "websocket" }),
      modelId: "gpt-5.4",
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as Model<"openai-chatgpt-responses">,
      options: {},
      expected: "websocket",
    },
    {
      name: "lets runtime options override configured transport",
      cfg: buildModelConfig("openai/gpt-5.4", { transport: "websocket" }),
      modelId: "gpt-5.4",
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as Model<"openai-chatgpt-responses">,
      options: { transport: "sse" as const },
      expected: "sse",
    },
  ])("$name", ({ cfg, modelId, model, options, expected }) => {
    const { calls, agent } = createOptionsCaptureAgent();
    applyExtraParamsToAgent(agent, cfg, "openai", modelId);

    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, options);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe(expected);
  });

  it("preserves maxTokens: 0 in shared extra params for providers that forward it", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = buildModelConfig("openai/gpt-5", {
      maxTokens: 0,
    });

    applyExtraParamsToAgent(agent, cfg, "openai", "gpt-5");

    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxTokens).toBe(0);
  });

  it("injects native Codex web_search for direct openai Responses models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: {
        auth: {
          profiles: {
            "openai:default": {
              provider: "openai",
              mode: "oauth",
            },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: {
                enabled: true,
                mode: "live",
                allowedDomains: ["example.com"],
              },
            },
          },
        },
      },
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as Model<"openai-chatgpt-responses">,
      payload: { tools: [{ type: "function", name: "read" }] },
    });

    expect(payload.tools).toEqual([
      { type: "function", name: "read" },
      {
        type: "web_search",
        external_web_access: true,
        filters: { allowed_domains: ["example.com"] },
      },
    ]);
  });

  it("does not inject duplicate native Codex web_search tools", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: {
        auth: {
          profiles: {
            "openai:default": {
              provider: "openai",
              mode: "oauth",
            },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: {
                enabled: true,
                mode: "cached",
              },
            },
          },
        },
      },
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as Model<"openai-chatgpt-responses">,
      payload: { tools: [{ type: "web_search" }] },
    });

    expect(payload.tools).toEqual([{ type: "web_search" }]);
  });

  it("keeps payload unchanged when Codex native search is inactive", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      cfg: {
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: {
                enabled: true,
                mode: "cached",
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
      } as unknown as Model<"openai-responses">,
      payload: { tools: [{ type: "function", name: "read" }] },
    });

    expect(payload.tools).toEqual([{ type: "function", name: "read" }]);
  });

  it("composes transport extra-param hooks after provider preparation", () => {
    const resolveProviderExtraParamsForTransport = vi.fn((_params) => ({
      patch: {
        hookApplied: true,
      },
    }));
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: (params) => ({
        ...params.context.extraParams,
        transport: "websocket",
      }),
      resolveProviderExtraParamsForTransport,
      wrapProviderStreamFn: (params) => params.context.streamFn,
    });

    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    } as Model<"openai-responses">;
    const effectiveExtraParams = resolvePreparedExtraParams({
      cfg: undefined,
      provider: "openai",
      modelId: "gpt-5",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      model,
    });

    expect(effectiveExtraParams.transport).toBe("websocket");
    expect(effectiveExtraParams.hookApplied).toBe(true);
    expect(resolveProviderExtraParamsForTransport).toHaveBeenCalledTimes(1);
    const hookCall = firstTransportHookCall(resolveProviderExtraParamsForTransport);
    const hookContext = hookCall.context as
      | {
          model?: unknown;
          transport?: string;
          agentDir?: string;
          workspaceDir?: string;
        }
      | undefined;
    expect(hookCall.provider).toBe("openai");
    expect(hookContext?.model).toBe(model);
    expect(hookContext?.transport).toBe("websocket");
    expect(hookContext?.agentDir).toBe("/tmp/agent");
    expect(hookContext?.workspaceDir).toBe("/tmp/workspace");
  });

  it("passes explicit settings transport to transport extra-param hooks", () => {
    const resolveProviderExtraParamsForTransport = vi.fn((_params) => ({
      patch: {
        hookApplied: true,
      },
    }));
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: (params) => ({
        ...params.context.extraParams,
        transport: "auto",
      }),
      resolveProviderExtraParamsForTransport,
      wrapProviderStreamFn: (params) => params.context.streamFn,
    });

    const resolvedTransport = resolveExplicitSettingsTransport({
      settingsManager: {
        getGlobalSettings: () => ({ transport: "websocket" }),
        getProjectSettings: () => ({}),
      },
      sessionTransport: "websocket",
    });
    const effectiveExtraParams = resolvePreparedExtraParams({
      cfg: undefined,
      provider: "openai",
      modelId: "gpt-5",
      resolvedTransport,
    });

    expect(effectiveExtraParams.transport).toBe("auto");
    expect(effectiveExtraParams.hookApplied).toBe(true);
    expect(resolveProviderExtraParamsForTransport).toHaveBeenCalledTimes(1);
    const hookCall = firstTransportHookCall(resolveProviderExtraParamsForTransport);
    const hookContext = hookCall.context as { transport?: string } | undefined;
    expect(hookContext?.transport).toBe("websocket");
  });

  it("applies transport hook parallel_tool_calls patches to request payloads", () => {
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: () => undefined,
      resolveProviderExtraParamsForTransport: () => ({
        patch: {
          parallel_tool_calls: true,
        },
      }),
      wrapProviderStreamFn: (params) => params.context.streamFn,
    });
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "test-openai",
      applyModelId: "gpt-compatible",
      model: {
        api: "openai-responses",
        provider: "test-openai",
        id: "gpt-compatible",
      } as Model<"openai-responses">,
      payload: {},
    });

    expect(payload.parallel_tool_calls).toBe(true);
  });

  it("uses prepared transport when session settings did not explicitly set one", () => {
    const effectiveExtraParams = resolvePreparedExtraParams({
      cfg: undefined,
      provider: "openai",
      modelId: "gpt-5.4",
    });

    expect(
      resolveAgentTransportOverride({
        settingsManager: {
          getGlobalSettings: () => ({}),
          getProjectSettings: () => ({}),
        },
        effectiveExtraParams,
      }),
    ).toBe("auto");
  });

  it("keeps explicit session transport over prepared OpenAI defaults", () => {
    const effectiveExtraParams = resolvePreparedExtraParams({
      cfg: undefined,
      provider: "openai",
      modelId: "gpt-5",
    });

    expect(
      resolveAgentTransportOverride({
        settingsManager: {
          getGlobalSettings: () => ({ transport: "sse" }),
          getProjectSettings: () => ({}),
        },
        effectiveExtraParams,
      }),
    ).toBeUndefined();
  });

  it("resolves explicit settings transport from the active session transport", () => {
    expect(
      resolveExplicitSettingsTransport({
        settingsManager: {
          getGlobalSettings: () => ({}),
          getProjectSettings: () => ({}),
        },
        sessionTransport: "websocket",
      }),
    ).toBeUndefined();
    expect(
      resolveExplicitSettingsTransport({
        settingsManager: {
          getGlobalSettings: () => ({ transport: "sse" }),
          getProjectSettings: () => ({}),
        },
        sessionTransport: "websocket",
      }),
    ).toBe("websocket");
  });

  it("strips prototype pollution keys from extra params overrides", () => {
    const effectiveExtraParams = resolvePreparedExtraParams({
      cfg: undefined,
      provider: "openai",
      modelId: "gpt-5",
      extraParamsOverride: {
        __proto__: { polluted: true },
        constructor: "blocked",
        prototype: "blocked",
        temperature: 0.2,
      },
    });

    expect(effectiveExtraParams.temperature).toBe(0.2);
    expect(Object.hasOwn(effectiveExtraParams, "__proto__")).toBe(false);
    expect(Object.hasOwn(effectiveExtraParams, "constructor")).toBe(false);
    expect(Object.hasOwn(effectiveExtraParams, "prototype")).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it.each([
    {
      name: "Anthropic Bedrock models",
      model: {
        api: "openai-completions",
        provider: "amazon-bedrock",
        id: "us.anthropic.claude-opus-4-6-v1",
      } as Model<"openai-completions">,
      expected: "long",
    },
    {
      name: "completions with prompt-cache-key support",
      model: {
        api: "openai-completions",
        provider: "omlx-local",
        id: "local_model",
        compat: { supportsPromptCacheKey: true },
      } as Model<"openai-completions">,
      expected: "long",
    },
    {
      name: "completions without prompt-cache-key support",
      model: {
        api: "openai-completions",
        provider: "omlx-local",
        id: "local_model",
      } as Model<"openai-completions">,
      expected: undefined,
    },
    {
      name: "custom Anthropic providers",
      model: {
        api: "anthropic-messages",
        provider: "litellm",
        id: "claude-sonnet-4-6",
      } as Model<"anthropic-messages">,
      expected: "long",
    },
  ])("resolves explicit cache retention for $name", ({ model, expected }) => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = buildModelConfig(`${model.provider}/${model.id}`, { cacheRetention: "long" });
    applyExtraParamsToAgent(
      agent,
      cfg,
      model.provider,
      model.id,
      undefined,
      undefined,
      undefined,
      undefined,
      model.api === "anthropic-messages" ? model : undefined,
    );
    void agent.streamFn?.(model, { messages: [] }, { sessionId: "session-81281" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cacheRetention).toBe(expected);
    expect(calls[0]?.sessionId).toBe("session-81281");
  });

  it("forces store=true for azure-openai provider with openai-responses API (#42800)", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "azure-openai",
      applyModelId: "gpt-5-mini",
      model: {
        api: "openai-responses",
        provider: "azure-openai",
        id: "gpt-5-mini",
        baseUrl: "https://myresource.openai.azure.com/openai/v1",
      } as Model<"openai-responses">,
    });
    expect(payload.store).toBe(true);
  });

  it("keeps Responses replay item ids enabled for direct OpenAI store-enabled requests", () => {
    expect(
      captureOpenAIResponsesWrapperReplay({
        model: buildResponsesWrapperModel({
          provider: "openai",
          id: "gpt-5",
          baseUrl: "https://api.openai.com/v1",
        }),
        options: {},
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "Azure OpenAI store-enabled requests",
      model: buildResponsesWrapperModel({
        provider: "azure-openai",
        id: "gpt-5-mini",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      }),
      options: {},
      expectedReplay: true,
    },
    {
      name: "store-capable third-party Responses routes",
      model: buildResponsesWrapperModel({
        provider: "custom-openai-responses",
        id: "store-capable-model",
        baseUrl: "https://custom.example.invalid/v1",
        compat: { supportsStore: true },
      }),
      options: { replayResponsesItemIds: true },
      expectedReplay: true,
    },
    {
      name: "storeless custom Responses routes",
      model: buildResponsesWrapperModel({
        provider: "custom-openai-responses",
        id: "gpt-5.5",
        baseUrl: "https://custom.example.invalid/v1",
        compat: { supportsStore: false },
      }),
      options: {},
      expectedReplay: false,
    },
  ] satisfies Array<{
    name: string;
    model: Model<"openai-responses">;
    options: OpenAIResponsesWrapperOptions;
    expectedReplay: boolean;
  }>)("sets replay item ids for $name", ({ model, options, expectedReplay }) => {
    expect(captureOpenAIResponsesWrapperReplay({ model, options })).toBe(expectedReplay);
  });

  it("injects configured text verbosity into Codex Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: buildModelConfig("openai/gpt-5.4", { text_verbosity: "high" }),
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://chatgpt.com/backend-api/codex/responses",
      } as Model<"openai-chatgpt-responses">,
      payload: { store: false, text: { verbosity: "medium" } },
    });
    expect(payload.text).toEqual({ verbosity: "high" });
  });

  it("lets null runtime override suppress inherited text verbosity injection", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: buildModelConfig("openai/gpt-5.4", {
        textVerbosity: "high",
      }),
      extraParamsOverride: {
        text_verbosity: null,
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("text");
  });

  it("keeps existing context_management when stripping store for supportsStore=false models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "custom-openai-responses",
      applyModelId: "gemini-2.5-pro",
      model: {
        api: "openai-responses",
        provider: "custom-openai-responses",
        id: "gemini-2.5-pro",
        name: "gemini-2.5-pro",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        compat: { supportsStore: false },
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
        context_management: [{ type: "compaction", compact_threshold: 12_345 }],
      },
    });
    expect(payload).not.toHaveProperty("store");
    expect(payload.context_management).toEqual([{ type: "compaction", compact_threshold: 12_345 }]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
