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
import { createAnthropicToolPayloadCompatibilityWrapper } from "../llm/providers/stream-wrappers/anthropic-family-tool-payload-compat.js";
import { createGoogleThinkingPayloadWrapper } from "../llm/providers/stream-wrappers/google.js";
import { createMinimaxFastModeWrapper } from "../llm/providers/stream-wrappers/minimax.js";
import {
  createCodexNativeWebSearchWrapper,
  createOpenAIAttributionHeadersWrapper,
  createOpenAICompletionsStrictMessageKeysWrapper,
  createOpenAIFastModeWrapper,
  createOpenAIReasoningCompatibilityWrapper,
  createOpenAIResponsesContextManagementWrapper,
  createOpenAIServiceTierWrapper,
  createOpenAIStringContentWrapper,
  createOpenAITextVerbosityWrapper,
  createOpenAIThinkingLevelWrapper,
  resolveOpenAIFastMode,
  resolveOpenAIServiceTier,
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
      if (params.provider === "test-anthropic-tool-compat") {
        return createAnthropicToolPayloadCompatibilityWrapper(params.context.streamFn, {
          toolSchemaMode: "openai-functions",
          toolChoiceMode: "openai-string-modes",
        });
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

  if (resolveOpenAIFastMode(params.context.extraParams)) {
    streamFn = createOpenAIFastModeWrapper(streamFn);
  }

  const serviceTier = resolveOpenAIServiceTier(params.context.extraParams);
  if (serviceTier) {
    streamFn = createOpenAIServiceTierWrapper(streamFn, serviceTier);
  }

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

  function runResolvedModelIdCase(params: {
    applyProvider: string;
    applyModelId: string;
    model: Model<"anthropic-messages"> | Model<"openai-completions">;
    cfg?: Record<string, unknown>;
    extraParamsOverride?: Record<string, unknown>;
  }): string {
    let resolvedModelId = params.model.id;
    const baseStreamFn: StreamFn = (model) => {
      resolvedModelId = model.id;
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(
      agent,
      params.cfg as Parameters<typeof applyExtraParamsToAgent>[1],
      params.applyProvider,
      params.applyModelId,
      params.extraParamsOverride,
    );
    const context: Context = { messages: [] };
    void agent.streamFn?.(params.model, context, {});
    return resolvedModelId;
  }

  function runParallelToolCallsPayloadMutationCase(params: {
    applyProvider: string;
    applyModelId: string;
    model:
      | Model<"openai-completions">
      | Model<"openai-responses">
      | Model<"openai-chatgpt-responses">
      | Model<"azure-openai-responses">
      | Model<"anthropic-messages">
      | Model<"google-generative-ai">;
    cfg?: Record<string, unknown>;
    extraParamsOverride?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  }) {
    // This bypasses provider wrappers so the test observes only core
    // parallel_tool_calls alias handling.
    return withMinimalProviderRuntimeDepsForTest(() => {
      const payload = params.payload ?? {};
      const baseStreamFn: StreamFn = (model, _context, options) => {
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
      );
      const context: Context = { messages: [] };
      void agent.streamFn?.(params.model, context, {});
      return payload;
    });
  }

  it.each([
    {
      name: "disables thinking for MiniMax anthropic-messages payloads",
      modelId: "MiniMax-M2.7",
      thinkingLevel: undefined,
      payload: () => ({}),
      options: {},
      expectedPayloads: [{ thinking: { type: "disabled" } }],
    },
    {
      name: "removes implicit disabled thinking for MiniMax-M3 anthropic-messages payloads",
      modelId: "MiniMax-M3",
      thinkingLevel: undefined,
      payload: () => ({ thinking: { type: "disabled" } }),
      options: {},
      expectedPayloads: [{}],
    },
    {
      name: "preserves explicit off thinking for MiniMax-M3 anthropic-messages payloads",
      modelId: "MiniMax-M3",
      thinkingLevel: "off" as const,
      payload: () => ({ thinking: { type: "disabled" } }),
      options: {},
      expectedPayloads: [{ thinking: { type: "disabled" } }],
    },
    {
      name: "rewrites MiniMax-M3 default budget thinking to adaptive",
      modelId: "MiniMax-M3",
      thinkingLevel: "adaptive" as const,
      payload: () => ({ thinking: { type: "enabled", budget_tokens: 1024 } }),
      options: {},
      expectedPayloads: [{ thinking: { type: "adaptive" } }],
    },
    {
      name: "restores explicit MiniMax-M3 maxTokens when rewriting budget thinking",
      modelId: "MiniMax-M3",
      thinkingLevel: "adaptive" as const,
      payload: () => ({
        max_tokens: 8692,
        thinking: { type: "enabled", budget_tokens: 8192 },
      }),
      options: { maxTokens: 500 },
      expectedPayloads: [{ max_tokens: 500, thinking: { type: "adaptive" } }],
    },
    {
      name: "preserves downstream explicit MiniMax-M3 thinking overrides",
      modelId: "MiniMax-M3",
      thinkingLevel: undefined,
      payload: () => ({ thinking: { type: "disabled" } }),
      options: {
        onPayload: (payload: unknown) => {
          (payload as Record<string, unknown>).thinking = { type: "disabled" };
        },
      },
      expectedPayloads: [{ thinking: { type: "disabled" } }],
    },
  ])("$name", ({ modelId, thinkingLevel, payload, options, expectedPayloads }) => {
    const mutatedPayload = runResponsesPayloadMutationCase({
      applyProvider: "minimax",
      applyModelId: modelId,
      thinkingLevel,
      model: {
        api: "anthropic-messages",
        provider: "minimax",
        id: modelId,
      } as Model<"anthropic-messages">,
      payload: payload(),
      options,
    });

    expect([mutatedPayload]).toStrictEqual(expectedPayloads);
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

  it("keeps OpenAI Responses web_search compatible when thinking is minimal", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "http://127.0.0.1:19191/v1",
        reasoning: true,
      } as unknown as Model<"openai-responses">,
      payload: {
        model: "gpt-5",
        input: [],
        tools: [
          {
            type: "function",
            name: "web_search",
            description: "Search the web",
            parameters: { type: "object", properties: {} },
          },
        ],
        reasoning: { effort: "low", summary: "auto" },
      },
      thinkingLevel: "minimal",
    });

    expect(payload.reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  it("strips disabled reasoning payloads for proxied OpenAI responses routes", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://proxy.example.com/v1",
      } as Model<"openai-responses">,
      payload: {
        reasoning: { effort: "none", summary: "auto" },
      },
      thinkingLevel: "off",
    });
    expect(payload).not.toHaveProperty("reasoning");
  });

  it.each([
    {
      name: "injects parallel_tool_calls for openai-completions payloads when configured",
      applyProvider: "nvidia-nim",
      applyModelId: "moonshotai/kimi-k2.5",
      configKey: "nvidia-nim/moonshotai/kimi-k2.5",
      params: { parallel_tool_calls: false },
      extraParamsOverride: undefined,
      model: {
        api: "openai-completions",
        provider: "nvidia-nim",
        id: "moonshotai/kimi-k2.5",
      } as Model<"openai-completions">,
      expected: false,
    },
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
      name: "injects parallel_tool_calls for openai-chatgpt-responses payloads when configured",
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      configKey: "openai/gpt-5.4",
      params: { parallelToolCalls: true },
      extraParamsOverride: undefined,
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      } as Model<"openai-chatgpt-responses">,
      expected: true,
    },
    {
      name: "injects parallel_tool_calls for azure-openai-responses payloads when configured",
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-5",
      configKey: "azure-openai-responses/gpt-5",
      params: { parallelToolCalls: true },
      extraParamsOverride: undefined,
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-5",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as Model<"azure-openai-responses">,
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

  it("strips store from proxied openai-completions payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "google",
      applyModelId: "gemini-2.5-pro",
      model: {
        api: "openai-completions",
        provider: "google",
        id: "gemini-2.5-pro",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      } as Model<"openai-completions">,
      payload: {
        messages: [],
        store: false,
      },
    });

    expect(payload).not.toHaveProperty("store");
  });

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
        extraBody: {
          google: { thinking_config: { thinking_budget: 0 } },
          store: false,
        },
      }),
      model: {
        api: "openai-completions",
        provider: "google",
        id: "gemini-2.5-pro",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      } as Model<"openai-completions">,
      payload: {
        messages: [],
      },
    });

    expect(payload.google).toEqual({ thinking_config: { thinking_budget: 0 } });
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

  it.each<[string, unknown]>([
    ["messages", [{ role: "user", content: "configured message" }]],
    ["model", "configured-model"],
    ["stream", true],
  ])("warns when extra_body overrides framework-managed %s", (key, value) => {
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
  });

  it("forwards chat_template_kwargs params as top-level openai-completions payload fields", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "vllm",
      applyModelId: "nemotron-3-super",
      cfg: buildModelConfig("vllm/nemotron-3-super", {
        chat_template_kwargs: {
          enable_thinking: false,
          force_nonempty_content: true,
        },
      }),
      model: {
        api: "openai-completions",
        provider: "vllm",
        id: "nemotron-3-super",
        baseUrl: "http://127.0.0.1:8000/v1",
      } as Model<"openai-completions">,
      payload: {
        messages: [],
      },
    });

    expect(payload.chat_template_kwargs).toEqual({
      enable_thinking: false,
      force_nonempty_content: true,
    });
  });

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
      model: {
        api: "openai-completions",
        provider: "google",
        id: "gemini-2.5-pro",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      } as Model<"openai-completions">,
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

  it("flattens pure text OpenAI completions message arrays for string-only compat models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "llmman",
      applyModelId: "gemma4",
      model: {
        api: "openai-completions",
        provider: "llmman",
        id: "gemma4",
        name: "Gemma 4 (llmman)",
        baseUrl: "http://127.0.0.1:17434/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 65536,
        maxTokens: 4096,
        compat: {
          requiresStringContent: true,
        } as Record<string, unknown>,
      } as unknown as Model<"openai-completions">,
      payload: {
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "System text" }],
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Line one" },
              { type: "text", text: "Line two" },
            ],
          },
        ],
      },
    });

    expect(payload.messages).toEqual([
      {
        role: "system",
        content: "System text",
      },
      {
        role: "user",
        content: "Line one\nLine two",
      },
    ]);
  });

  it("strips extra OpenAI completions message keys for strict-key compat models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "infomaniak",
      applyModelId: "mistral3",
      model: {
        api: "openai-completions",
        provider: "infomaniak",
        id: "mistral3",
        name: "mistral3",
        baseUrl: "https://api.infomaniak.com/1/ai/example/openai",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 4096,
        compat: {
          strictMessageKeys: true,
        } as Record<string, unknown>,
      } as unknown as Model<"openai-completions">,
      payload: {
        messages: [
          {
            role: "assistant",
            content: "calling tool",
            name: "agent",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "noop" } }],
            cache_control: { type: "ephemeral" },
          },
          {
            role: "tool",
            content: "tool result",
            tool_call_id: "call_1",
          },
        ],
      },
    });

    expect(payload.messages).toEqual([
      {
        role: "assistant",
        content: "calling tool",
      },
      {
        role: "tool",
        content: "tool result",
      },
    ]);
  });

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
      name: "does not inject parallel_tool_calls for google-generative-ai APIs",
      applyProvider: "google",
      applyModelId: "gemini-2.5-pro",
      cfg: buildModelConfig("google/gemini-2.5-pro", {
        parallel_tool_calls: false,
      }),
      extraParamsOverride: undefined,
      model: {
        api: "google-generative-ai",
        provider: "google",
        id: "gemini-2.5-pro",
      } as Model<"google-generative-ai">,
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

  it("keeps thinking=off unchanged for non-Pro SiliconFlow model IDs", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "siliconflow",
      applyModelId: "deepseek-ai/DeepSeek-V3.2",
      model: {
        api: "openai-completions",
        provider: "siliconflow",
        id: "deepseek-ai/DeepSeek-V3.2",
      } as Model<"openai-completions">,
      payload: { thinking: "off" },
      thinkingLevel: "off",
    });
    expect(payload?.thinking).toBe("off");
  });

  it("keeps anthropic tool payloads native for Kimi", () => {
    withMinimalProviderRuntimeDepsForTest(() => {
      const payload = runResponsesPayloadMutationCase({
        applyProvider: "kimi",
        applyModelId: "kimi-code",
        model: {
          api: "anthropic-messages",
          provider: "kimi",
          id: "kimi-code",
          baseUrl: "https://api.kimi.com/coding/",
        } as Model<"anthropic-messages">,
        payload: {
          tools: [
            {
              name: "read",
              description: "Read file",
              input_schema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
          ],
          tool_choice: { type: "tool", name: "read" },
        },
        thinkingLevel: "low",
      });
      expect(payload?.tools).toEqual([
        {
          name: "read",
          description: "Read file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ]);
      expect(payload?.tool_choice).toEqual({ type: "tool", name: "read" });
    });
  });

  it("does not rewrite anthropic tool schema for non-kimi endpoints", () => {
    withMinimalProviderRuntimeDepsForTest(() => {
      const payload = runResponsesPayloadMutationCase({
        applyProvider: "anthropic",
        applyModelId: "claude-sonnet-4-6",
        model: {
          api: "anthropic-messages",
          provider: "anthropic",
          id: "claude-sonnet-4-6",
          baseUrl: "https://api.anthropic.com",
        } as Model<"anthropic-messages">,
        payload: {
          tools: [
            {
              name: "read",
              description: "Read file",
              input_schema: { type: "object", properties: {} },
            },
          ],
        },
        thinkingLevel: "low",
      });
      expect(payload?.tools).toEqual([
        {
          name: "read",
          description: "Read file",
          input_schema: { type: "object", properties: {} },
        },
      ]);
    });
  });

  it("uses explicit compat metadata for anthropic tool payload normalization", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        tools: [
          {
            name: "read",
            description: "Read file",
            input_schema: { type: "object", properties: {} },
          },
        ],
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const streamFn = createAnthropicToolPayloadCompatibilityWrapper(baseStreamFn);

    const model = {
      api: "anthropic-messages",
      provider: "custom-anthropic-proxy",
      id: "proxy-model",
      compat: {
        requiresOpenAiAnthropicToolPayload: true,
      },
    } as unknown as Model<"anthropic-messages">;
    const context: Context = { messages: [] };
    void streamFn(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "Read file",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });

  it("lets provider-owned wrappers normalize anthropic tool payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "test-anthropic-tool-compat",
      applyModelId: "proxy-model",
      model: {
        api: "anthropic-messages",
        provider: "test-anthropic-tool-compat",
        id: "proxy-model",
      } as Model<"anthropic-messages">,
      payload: {
        tools: [
          {
            name: "read",
            description: "Read file",
            input_schema: { type: "object", properties: {} },
          },
        ],
        tool_choice: { type: "any" },
      },
      thinkingLevel: "low",
    });
    expect(payload?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "Read file",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    expect(payload?.tool_choice).toBe("required");
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

  it.each([
    {
      name: "rewrites Gemini 3 thinkingBudget to thinkingLevel",
      provider: "atproxy",
      modelId: "gemini-3.1-pro-high",
      reasoning: undefined,
      thinkingLevel: "high" as const,
      payload: () => ({
        config: { thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 } },
      }),
      expectedConfig: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
      },
    },
    {
      name: "rewrites Gemma 4 thinkingBudget to a supported Google thinkingLevel",
      provider: "google",
      modelId: "gemma-4-26b-a4b-it",
      reasoning: true,
      thinkingLevel: "high" as const,
      payload: () => ({
        config: { thinkingConfig: { includeThoughts: true, thinkingBudget: 24576 } },
      }),
      expectedConfig: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
      },
    },
    {
      name: "preserves explicit Gemma 4 thinking level when thinkingBudget=0",
      provider: "google",
      modelId: "gemma-4-26b-a4b-it",
      reasoning: true,
      thinkingLevel: "high" as const,
      payload: () => ({ config: { thinkingConfig: { thinkingBudget: 0 } } }),
      expectedConfig: { thinkingConfig: { thinkingLevel: "HIGH" } },
    },
  ])("$name", ({ provider, modelId, reasoning, thinkingLevel, payload, expectedConfig }) => {
    const payloads = [
      runResponsesPayloadMutationCase({
        applyProvider: provider,
        applyModelId: modelId,
        thinkingLevel,
        model: {
          api: "google-generative-ai",
          provider,
          id: modelId,
          ...(reasoning === undefined ? {} : { reasoning }),
        } as Model<"google-generative-ai">,
        payload: payload(),
      }),
    ];

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.config).toEqual(expectedConfig);
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
      name: "defaults Codex transport to auto (WebSocket-first)",
      cfg: undefined,
      modelId: "gpt-5.4",
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as Model<"openai-chatgpt-responses">,
      options: {},
      expected: "auto",
    },
    {
      name: "defaults OpenAI transport to auto",
      cfg: undefined,
      modelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
      } as Model<"openai-responses">,
      options: {},
      expected: "auto",
    },
    {
      name: "lets runtime options override OpenAI default transport",
      cfg: undefined,
      modelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
      } as Model<"openai-responses">,
      options: { transport: "sse" as const },
      expected: "sse",
    },
    {
      name: "allows forcing Codex transport to SSE",
      cfg: buildModelConfig("openai/gpt-5.4", { transport: "sse" }),
      modelId: "gpt-5.4",
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as Model<"openai-chatgpt-responses">,
      options: {},
      expected: "sse",
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
    {
      name: "falls back to Codex default transport when configured value is invalid",
      cfg: buildModelConfig("openai/gpt-5.4", { transport: "udp" }),
      modelId: "gpt-5.4",
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as Model<"openai-chatgpt-responses">,
      options: {},
      expected: "auto",
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

  it("injects GPT-5 default parallel tool calls and low verbosity for OpenAI Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as unknown as Model<"openai-responses">,
      payload: {},
    });

    expect(payload.parallel_tool_calls).toBe(true);
    expect(payload.text).toEqual({ verbosity: "low" });
  });

  it("injects GPT-5 default parallel tool calls for Codex Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as Model<"openai-chatgpt-responses">,
      payload: {},
    });

    expect(payload.parallel_tool_calls).toBe(true);
    expect(payload.text).toEqual({ verbosity: "low" });
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

  it("prepares extra params from each model's transport inputs", () => {
    const resolveProviderExtraParamsForTransport = vi.fn((params) => ({
      patch: {
        transportFamily: params.context.model?.api,
        baseUrl: (params.context.model as Record<string, unknown> | undefined)?.baseUrl,
        headerAuth: (
          (params.context.model as Record<string, unknown> | undefined)?.headers as
            | Record<string, unknown>
            | undefined
        )?.["X-Test"],
      },
    }));
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: (params) => params.context.extraParams,
      resolveProviderExtraParamsForTransport,
      wrapProviderStreamFn: (params) => params.context.streamFn,
    });
    const cfg = {};

    const responsesParams = resolvePreparedExtraParams({
      cfg,
      provider: "openai",
      modelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api-one.example/v1",
        headers: { "X-Test": "one" },
      } as unknown as Model<"openai-responses">,
    });
    const completionsParams = resolvePreparedExtraParams({
      cfg,
      provider: "openai",
      modelId: "gpt-5",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api-one.example/v1",
        headers: { "X-Test": "one" },
      } as unknown as Model<"openai-completions">,
    });
    const differentModelHeadersParams = resolvePreparedExtraParams({
      cfg,
      provider: "openai",
      modelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api-two.example/v1",
        headers: { "X-Test": "two" },
      } as unknown as Model<"openai-responses">,
    });
    const repeatedResponsesParams = resolvePreparedExtraParams({
      cfg,
      provider: "openai",
      modelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api-one.example/v1",
        headers: { "X-Test": "one" },
      } as unknown as Model<"openai-responses">,
    });

    expect(responsesParams.transportFamily).toBe("openai-responses");
    expect(completionsParams.transportFamily).toBe("openai-completions");
    expect(differentModelHeadersParams.baseUrl).toBe("https://api-two.example/v1");
    expect(differentModelHeadersParams.headerAuth).toBe("two");
    expect(repeatedResponsesParams.transportFamily).toBe("openai-responses");
    expect(resolveProviderExtraParamsForTransport).toHaveBeenCalledTimes(4);
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

  it("keeps Anthropic Bedrock models eligible for provider-side caching", () => {
    const { calls, agent } = createOptionsCaptureAgent();

    applyExtraParamsToAgent(agent, undefined, "amazon-bedrock", "us.anthropic.claude-sonnet-4-5");

    const model = {
      api: "openai-completions",
      provider: "amazon-bedrock",
      id: "us.anthropic.claude-sonnet-4-5",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cacheRetention).toBeUndefined();
  });

  it("passes through explicit cacheRetention for Anthropic Bedrock models", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = buildModelConfig("amazon-bedrock/us.anthropic.claude-opus-4-6-v1", {
      cacheRetention: "long",
    });

    applyExtraParamsToAgent(agent, cfg, "amazon-bedrock", "us.anthropic.claude-opus-4-6-v1");

    const model = {
      api: "openai-completions",
      provider: "amazon-bedrock",
      id: "us.anthropic.claude-opus-4-6-v1",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cacheRetention).toBe("long");
  });

  it("passes through explicit cacheRetention for prompt-cache-key openai-completions providers", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = buildModelConfig("omlx-local/local_model", {
      cacheRetention: "long",
    });

    applyExtraParamsToAgent(agent, cfg, "omlx-local", "local_model");

    const model = {
      api: "openai-completions",
      provider: "omlx-local",
      id: "local_model",
      compat: { supportsPromptCacheKey: true },
    } as unknown as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {
      sessionId: "session-81281",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cacheRetention).toBe("long");
    expect(calls[0]?.sessionId).toBe("session-81281");
  });

  it("keeps explicit cacheRetention off openai-completions providers without prompt-cache-key support", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = buildModelConfig("omlx-local/local_model", {
      cacheRetention: "long",
    });

    applyExtraParamsToAgent(agent, cfg, "omlx-local", "local_model");

    const model = {
      api: "openai-completions",
      provider: "omlx-local",
      id: "local_model",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {
      sessionId: "session-81281",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cacheRetention).toBeUndefined();
    expect(calls[0]?.sessionId).toBe("session-81281");
  });

  it("passes through explicit cacheRetention for custom anthropic-messages providers", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = buildModelConfig("litellm/claude-sonnet-4-6", {
      cacheRetention: "long",
    });

    applyExtraParamsToAgent(
      agent,
      cfg,
      "litellm",
      "claude-sonnet-4-6",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        api: "anthropic-messages",
        provider: "litellm",
        id: "claude-sonnet-4-6",
      } as Model<"anthropic-messages">,
    );

    const context: Context = { messages: [] };

    void agent.streamFn?.(
      {
        api: "anthropic-messages",
        provider: "litellm",
        id: "claude-sonnet-4-6",
      } as Model<"anthropic-messages">,
      context,
      {},
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cacheRetention).toBe("long");
  });

  it.each([
    {
      name: "forces store=true for direct OpenAI Responses payloads",
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
    },
    {
      name: "forces store=true for azure-openai provider with openai-responses API (#42800)",
      applyProvider: "azure-openai",
      applyModelId: "gpt-5-mini",
      model: {
        api: "openai-responses",
        provider: "azure-openai",
        id: "gpt-5-mini",
        baseUrl: "https://myresource.openai.azure.com/openai/v1",
      } as Model<"openai-responses">,
    },
  ])("$name", ({ applyProvider, applyModelId, model }) => {
    const payload = runResponsesPayloadMutationCase({ applyProvider, applyModelId, model });

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

  it.each([
    {
      name: "strips disabled OpenAI reasoning payloads on native Responses models that do not support none",
      applyProvider: "openai",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5-mini",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
    },
    {
      name: "strips disabled Azure OpenAI Responses reasoning payloads for models that do not support none",
      applyProvider: "azure-openai-responses",
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-5-mini",
        baseUrl: "https://myresource.openai.azure.com/openai/v1",
      } as Model<"azure-openai-responses">,
    },
  ])("$name", ({ applyProvider, model }) => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider,
      applyModelId: "gpt-5-mini",
      model,
      payload: { store: false, reasoning: { effort: "none" } },
    });

    expect(payload).not.toHaveProperty("reasoning");
  });

  it.each([
    {
      name: "injects configured OpenAI service_tier into Responses payloads",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: undefined,
      expectedTier: "priority",
    },
    {
      name: "injects configured OpenAI service_tier into Codex Responses payloads",
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://chatgpt.com/backend-api",
      } as Model<"openai-chatgpt-responses">,
      payload: undefined,
      expectedTier: "priority",
    },
    {
      name: "preserves caller-provided service_tier values",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: { store: false, service_tier: "default" },
      expectedTier: "default",
    },
  ])("$name", ({ model, payload: initialPayload, expectedTier }) => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: buildModelConfig("openai/gpt-5.4", { serviceTier: "priority" }),
      model,
      payload: initialPayload,
    });

    expect(payload.service_tier).toBe(expectedTier);
  });

  it.each([
    {
      name: "injects configured OpenAI text verbosity into Responses payloads",
      params: { textVerbosity: "low" },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: undefined,
      expectedText: { verbosity: "low" },
    },
    {
      name: "injects configured text verbosity into Codex Responses payloads",
      params: { text_verbosity: "high" },
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://chatgpt.com/backend-api/codex/responses",
      } as Model<"openai-chatgpt-responses">,
      payload: { store: false, text: { verbosity: "medium" } },
      expectedText: { verbosity: "high" },
    },
    {
      name: "preserves caller-provided payload.text keys when injecting text verbosity",
      params: { text_verbosity: "medium" },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: { store: false, text: { format: { type: "text" } } },
      expectedText: { format: { type: "text" }, verbosity: "medium" },
    },
    {
      name: "preserves caller-provided payload.text.verbosity for OpenAI Responses",
      params: { textVerbosity: "low" },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: { store: false, text: { verbosity: "high" } },
      expectedText: { verbosity: "high" },
    },
  ])("$name", ({ params, model, payload: initialPayload, expectedText }) => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: buildModelConfig("openai/gpt-5.4", params),
      model,
      payload: initialPayload,
    });

    expect(payload.text).toEqual(expectedText);
  });

  it("warns and skips invalid OpenAI text verbosity values", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runResponsesPayloadMutationCase({
        applyProvider: "openai",
        applyModelId: "gpt-5.4",
        cfg: buildModelConfig("openai/gpt-5.4", {
          textVerbosity: "loud",
        }),
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
        } as unknown as Model<"openai-responses">,
      });
      expect(payload).not.toHaveProperty("text");
      expect(warnSpy).toHaveBeenCalledWith("ignoring invalid OpenAI text verbosity param: loud");
    } finally {
      warnSpy.mockRestore();
    }
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

  it("ignores OpenAI text verbosity params for non-OpenAI providers without warning", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runResponsesPayloadMutationCase({
        applyProvider: "anthropic",
        applyModelId: "claude-sonnet-4-5",
        cfg: buildModelConfig("anthropic/claude-sonnet-4-5", {
          textVerbosity: "high",
        }),
        model: {
          api: "anthropic-messages",
          provider: "anthropic",
          id: "claude-sonnet-4-5",
          baseUrl: "https://api.anthropic.com",
        } as unknown as Model<"anthropic-messages">,
        payload: {},
      });
      expect(payload).not.toHaveProperty("text");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it.each([
    {
      name: "maps fast mode to priority service_tier for direct OpenAI Responses",
      cfg: buildModelConfig("openai/gpt-5.4", { fastMode: true }),
      extraParamsOverride: undefined,
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
    },
    {
      name: "maps fast mode to priority service_tier for openai responses",
      cfg: undefined,
      extraParamsOverride: { fastMode: true },
      model: {
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://chatgpt.com/backend-api",
      } as Model<"openai-chatgpt-responses">,
    },
  ])("$name", ({ cfg, extraParamsOverride, model }) => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg,
      extraParamsOverride,
      model,
      payload: { store: false },
    });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload.text).toEqual({ verbosity: "low" });
    expect(payload.service_tier).toBe("priority");
  });

  it("preserves caller-provided OpenAI payload fields when fast mode is enabled", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
      payload: {
        reasoning: { effort: "medium" },
        text: { verbosity: "high" },
        service_tier: "default",
      },
    });
    expect(payload.reasoning).toEqual({ effort: "medium" });
    expect(payload.text).toEqual({ verbosity: "high" });
    expect(payload.service_tier).toBe("default");
  });

  it.each([
    {
      name: "maps MiniMax /fast to the matching highspeed model",
      applyProvider: "minimax",
      applyModelId: "MiniMax-M2.7",
      fastMode: true,
      model: {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M2.7",
        baseUrl: "https://api.minimax.io/anthropic",
      } as Model<"anthropic-messages">,
      expectedModelId: "MiniMax-M2.7-highspeed",
    },
    {
      name: "keeps explicit MiniMax highspeed models unchanged when /fast is off",
      applyProvider: "minimax-portal",
      applyModelId: "MiniMax-M2.7-highspeed",
      fastMode: false,
      model: {
        api: "anthropic-messages",
        provider: "minimax-portal",
        id: "MiniMax-M2.7-highspeed",
        baseUrl: "https://api.minimax.io/anthropic",
      } as Model<"anthropic-messages">,
      expectedModelId: "MiniMax-M2.7-highspeed",
    },
  ])("$name", ({ applyProvider, applyModelId, fastMode, model, expectedModelId }) => {
    const resolvedModelId = runResolvedModelIdCase({
      applyProvider,
      applyModelId,
      extraParamsOverride: { fastMode },
      model,
    });

    expect(resolvedModelId).toBe(expectedModelId);
  });

  it.each([
    {
      name: "does not inject service_tier for non-openai providers",
      applyProvider: "azure-openai-responses",
      configKey: "azure-openai-responses/gpt-5.4",
      serviceTier: "priority",
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-5.4",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as Model<"azure-openai-responses">,
    },
    {
      name: "does not inject service_tier for proxied openai base URLs",
      applyProvider: "openai",
      configKey: "openai/gpt-5.4",
      serviceTier: "priority",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://proxy.example.com/v1",
      } as Model<"openai-responses">,
    },
    {
      name: "does not inject service_tier for openai provider routed to Azure base URLs",
      applyProvider: "openai",
      configKey: "openai/gpt-5.4",
      serviceTier: "priority",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as Model<"openai-responses">,
    },
    {
      name: "skips service_tier injection for invalid serviceTier values",
      applyProvider: "openai",
      configKey: "openai/gpt-5.4",
      serviceTier: "invalid",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
    },
  ])("$name", ({ applyProvider, configKey, serviceTier, model }) => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider,
      applyModelId: "gpt-5.4",
      cfg: buildModelConfig(configKey, { serviceTier }),
      model,
    });

    expect(payload).not.toHaveProperty("service_tier");
  });

  it("does not force store for OpenAI Responses routed through non-OpenAI base URLs", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://proxy.example.com/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.store).toBe(false);
  });

  it("does not force store for OpenAI Responses when baseUrl is empty", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.store).toBe(false);
  });

  it("strips store from payload for models that declare supportsStore=false", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-4o",
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-4o",
        name: "gpt-4o",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
        compat: { supportsStore: false },
      } as unknown as Model<"azure-openai-responses">,
    });
    expect(payload).not.toHaveProperty("store");
  });

  it("strips store from payload for non-OpenAI responses providers with supportsStore=false", () => {
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
    });
    expect(payload).not.toHaveProperty("store");
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

  it.each([
    {
      name: "auto-injects OpenAI Responses context_management compaction for direct OpenAI models",
      applyProvider: "openai",
      applyModelId: "gpt-5",
      cfg: undefined,
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 200_000,
      } as Model<"openai-responses">,
      payload: undefined,
      expectedContext: [{ type: "compaction", compact_threshold: 140_000 }],
    },
    {
      name: "allows explicitly enabling OpenAI Responses context_management compaction",
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-4o",
      cfg: buildModelConfig("azure-openai-responses/gpt-4o", {
        responsesServerCompaction: true,
        responsesCompactThreshold: 42_000,
      }),
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-4o",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as Model<"azure-openai-responses">,
      payload: undefined,
      expectedContext: [{ type: "compaction", compact_threshold: 42_000 }],
    },
    {
      name: "preserves existing context_management payload values",
      applyProvider: "openai",
      applyModelId: "gpt-5",
      cfg: undefined,
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: {
        store: false,
        context_management: [{ type: "compaction", compact_threshold: 12_345 }],
      },
      expectedContext: [{ type: "compaction", compact_threshold: 12_345 }],
    },
  ])(
    "$name",
    ({ applyProvider, applyModelId, cfg, model, payload: initialPayload, expectedContext }) => {
      const payload = runResponsesPayloadMutationCase({
        applyProvider,
        applyModelId,
        cfg,
        model,
        payload: initialPayload,
      });

      expect(payload.context_management).toEqual(expectedContext);
    },
  );

  it.each([
    {
      name: "does not auto-inject OpenAI Responses context_management for Azure by default",
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-4o",
      cfg: undefined,
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-4o",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as Model<"azure-openai-responses">,
    },
    {
      name: "allows disabling OpenAI Responses context_management compaction via model params",
      applyProvider: "openai",
      applyModelId: "gpt-5",
      cfg: buildModelConfig("openai/gpt-5", { responsesServerCompaction: false }),
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
    },
  ])("$name", ({ applyProvider, applyModelId, cfg, model }) => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider,
      applyModelId,
      cfg,
      model,
    });

    expect(payload).not.toHaveProperty("context_management");
  });

  it.each([
    {
      name: "with openai provider config",
      run: () =>
        runResponsesPayloadMutationCase({
          applyProvider: "openai",
          applyModelId: "codex-mini-latest",
          model: {
            api: "openai-chatgpt-responses",
            provider: "openai",
            id: "codex-mini-latest",
            baseUrl: "https://chatgpt.com/backend-api/codex/responses",
          } as Model<"openai-chatgpt-responses">,
        }),
    },
    {
      name: "without config via provider/model hints",
      run: () =>
        runResponsesPayloadMutationCase({
          applyProvider: "openai",
          applyModelId: "codex-mini-latest",
          model: {
            api: "openai-chatgpt-responses",
            provider: "openai",
            id: "codex-mini-latest",
            baseUrl: "https://chatgpt.com/backend-api/codex/responses",
          } as Model<"openai-chatgpt-responses">,
          options: {},
        }),
    },
  ])(
    "does not force store=true for Codex responses (Codex requires store=false) ($name)",
    ({ run }) => {
      expect(run().store).toBe(false);
    },
  );

  it("strips prompt cache fields for non-OpenAI openai-responses endpoints", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "custom-proxy",
      applyModelId: "some-model",
      model: {
        api: "openai-responses",
        provider: "custom-proxy",
        id: "some-model",
        baseUrl: "https://my-proxy.example.com/v1",
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
        prompt_cache_key: "session-xyz",
        prompt_cache_retention: "24h",
      },
    });
    expect(payload).not.toHaveProperty("prompt_cache_key");
    expect(payload).not.toHaveProperty("prompt_cache_retention");
  });

  it.each([
    {
      name: "keeps prompt cache fields for direct OpenAI openai-responses endpoints",
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      cacheKey: "session-123",
    },
    {
      name: "keeps prompt cache fields for direct Azure OpenAI azure-openai-responses endpoints",
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-4o",
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-4o",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as Model<"azure-openai-responses">,
      cacheKey: "session-azure",
    },
    {
      name: "keeps prompt cache fields when openai-responses baseUrl is omitted",
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
      } as Model<"openai-responses">,
      cacheKey: "session-default",
    },
  ])("$name", ({ applyProvider, applyModelId, model, cacheKey }) => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider,
      applyModelId,
      model,
      payload: {
        store: false,
        prompt_cache_key: cacheKey,
        prompt_cache_retention: "24h",
      },
    });

    expect(payload.prompt_cache_key).toBe(cacheKey);
    expect(payload.prompt_cache_retention).toBe("24h");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
