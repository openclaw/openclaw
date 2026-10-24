import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import {
  registerProviderPlugin,
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  expectPassthroughReplayPolicy,
  expectUnifiedModelCatalogProviderRegistration,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const { loadedCapabilities, loadCapabilities } = vi.hoisted(() => ({
  loadedCapabilities: vi.fn(),
  loadCapabilities: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/provider-stream-family", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/provider-stream-family")>();
  return {
    ...actual,
    getLoadedOpenRouterModelCapabilities: loadedCapabilities,
    loadOpenRouterModelCapabilities: loadCapabilities,
  };
});

import openrouterPlugin from "./index.js";
import * as openRouterCatalog from "./provider-catalog.js";
import {
  buildOpenrouterProvider,
  isOpenRouterProxyReasoningUnsupportedModel,
} from "./provider-catalog.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";
const API = "https://openrouter.ai/api/v1";
const DEEPSEEK = "deepseek/deepseek-v4-pro";
const PROXY = "https://proxy.example.com/v1";
const EFFORTS: NonNullable<Parameters<StreamFn>[0]["compat"]> = {
  supportedReasoningEfforts: ["none", "high", "xhigh"],
};

function runtimeModel(
  id: string,
  overrides: Partial<Parameters<StreamFn>[0]> = {},
): Parameters<StreamFn>[0] {
  return {
    provider: "openrouter",
    id,
    name: id,
    api: "openai-completions",
    baseUrl: API,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  };
}

async function captureStream(params: {
  modelId: string;
  thinkingLevel?: string;
  payload: Record<string, unknown>;
  baseUrl?: string;
  compat?: Parameters<StreamFn>[0]["compat"];
  extraParams?: Record<string, unknown>;
  forwardPayload?: boolean;
  options?: Parameters<StreamFn>[2];
}) {
  const provider = await registerSingleProviderPlugin(openrouterPlugin);
  let capturedPayload: Record<string, unknown> | undefined;
  const streamFn = vi.fn((...args: Parameters<StreamFn>): ReturnType<StreamFn> => {
    void args[2]?.onPayload?.(params.payload, args[0]);
    if (!params.forwardPayload) {
      capturedPayload = params.payload;
    }
    return createAssistantMessageEventStream();
  });
  const wrapped = provider.wrapStreamFn?.({
    provider: "openrouter",
    modelId: params.modelId,
    streamFn,
    thinkingLevel: params.thinkingLevel,
    extraParams: params.extraParams,
  } as never);
  void wrapped?.(
    runtimeModel(params.modelId, { baseUrl: params.baseUrl, compat: params.compat ?? {} }) as never,
    { messages: [] },
    {
      ...params.options,
      ...(params.forwardPayload
        ? {
            onPayload: (payload: unknown) => (capturedPayload = payload as Record<string, unknown>),
          }
        : {}),
    },
  );
  expect(streamFn).toHaveBeenCalledOnce();
  const [model, , options] = streamFn.mock.calls[0]!;
  return { payload: capturedPayload, model, options };
}

function providerConfig<T>(openrouter: T) {
  return { models: { providers: { openrouter } } };
}

function dynamicContext(modelId: string) {
  return { provider: "openrouter", modelId, modelRegistry: { find: vi.fn(() => null) } as never };
}

async function capturePayload(
  modelId: string,
  thinkingLevel: string | undefined,
  payload: Record<string, unknown>,
  options: Omit<Parameters<typeof captureStream>[0], "modelId" | "thinkingLevel" | "payload"> = {},
) {
  return (await captureStream({ modelId, thinkingLevel, payload, ...options })).payload;
}

function hookContext(modelId: string) {
  return { provider: "openrouter", modelApi: "openai-completions", modelId };
}

function expectReasoning(payload: Record<string, unknown> | undefined, effort: string) {
  expect(payload?.reasoning).toEqual({ effort });
  expect(payload).not.toHaveProperty("thinking");
  expect(payload).not.toHaveProperty("reasoning_effort");
}
describe("openrouter provider hooks", () => {
  it("declares runtime text catalog discovery", () => {
    expect(manifest.modelCatalog?.discovery).toEqual({ openrouter: "runtime" });
  });

  it("registers OpenRouter speech alongside model, media, and catalog providers", async () => {
    const registered = await registerProviderPlugin({
      plugin: openrouterPlugin,
      id: "openrouter",
      name: "OpenRouter Provider",
    });
    for (const key of [
      "providers",
      "speechProviders",
      "mediaProviders",
      "imageProviders",
      "musicProviders",
      "videoProviders",
    ] as const) {
      expect(registered[key].map((provider) => provider.id)).toEqual(["openrouter"]);
    }
    expect(registered.providers[0]).toMatchObject({
      resolveUsageAuth: expect.any(Function),
      fetchUsageSnapshot: expect.any(Function),
    });
    for (const kind of ["text", "video_generation"] as const) {
      const catalog = expectUnifiedModelCatalogProviderRegistration({
        plugin: openrouterPlugin,
        pluginId: "openrouter",
        pluginName: "OpenRouter Provider",
        provider: "openrouter",
        kind,
      });
      expect(catalog.liveCatalog).toBeTypeOf("function");
      if (kind === "text") {
        expect(catalog.staticCatalog).toBeTypeOf("function");
      }
    }
  });

  it("registers OAuth and API-key auth methods", async () => {
    const authFields = [
      "provider",
      "method",
      "choiceId",
      "choiceLabel",
      "choiceHint",
      "groupId",
      "groupLabel",
      "groupHint",
      "onboardingScopes",
      "onboardingFeatured",
    ] as const;
    const selectChoice = (choice: Partial<Record<(typeof authFields)[number], unknown>>) =>
      Object.fromEntries(authFields.map((key) => [key, choice[key]]));
    const manifestChoices = manifest.providerAuthChoices.map(selectChoice);

    expect(
      provider.auth.map((method) => ({
        id: method.id,
        kind: method.kind,
        choiceId: method.wizard?.choiceId,
      })),
    ).toEqual([
      { id: "api-key", kind: "api_key", choiceId: "openrouter-api-key" },
      { id: "oauth", kind: "oauth", choiceId: "openrouter-oauth" },
    ]);
    expect(
      provider.auth.map((method) =>
        selectChoice({ ...method.wizard, provider: provider.id, method: method.id }),
      ),
    ).toEqual(manifestChoices);

    const choice = (id: string) =>
      resolveProviderPluginChoice({ providers: [provider], choice: id });
    expect(choice("openrouter")?.method.id).toBe("api-key");
    expect(choice("openrouter-oauth")?.method.id).toBe("oauth");
  });

  it("features OpenRouter OAuth in the top-level onboarding picker", () => {
    const oauthChoice = manifest.providerAuthChoices?.find(
      (choice) => choice.choiceId === "openrouter-oauth",
    );

    expect(oauthChoice).toMatchObject({
      provider: "openrouter",
      method: "oauth",
      groupId: "openrouter",
      groupLabel: "OpenRouter",
      onboardingFeatured: true,
    });
  });

  it("keeps current bundled models and excludes retired IDs", () => {
    const ids = buildOpenrouterProvider().models?.map((model) => model.id);
    expect(ids).toEqual(
      expect.arrayContaining(["moonshotai/kimi-k2.6", "moonshotai/kimi-k2.5", "openrouter/auto"]),
    );
    for (const id of ["auto", "openrouter/hunter-alpha", "openrouter/healer-alpha"]) {
      expect(ids).not.toContain(id);
    }
  });

  let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
  beforeEach(async () => {
    loadedCapabilities.mockReset();
    loadCapabilities.mockClear();
    provider = await registerSingleProviderPlugin(openrouterPlugin);
  });

  it("forwards proxy destination and policy to authenticated discovery", async () => {
    const configuredProvider = {
      apiKey: "synthetic-private-proxy-key",
      baseUrl: "https://private.example.invalid/router/v1///",
      request: { headers: { "X-Private-Proxy-Tenant": "synthetic-tenant" } },
      models: [],
    };
    const catalogSpy = vi
      .spyOn(openRouterCatalog, "buildOpenrouterLiveProvider")
      .mockResolvedValue(buildOpenrouterProvider());

    try {
      await provider.catalog?.run({
        config: providerConfig(configuredProvider),
        resolveProviderApiKey: () => ({
          apiKey: "OPENROUTER_API_KEY",
          discoveryApiKey: "synthetic-private-proxy-key",
        }),
      } as never);

      expect(catalogSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: configuredProvider.baseUrl,
          request: configuredProvider.request,
        }),
      );
    } finally {
      catalogSpy.mockRestore();
    }
  });

  it.each([
    { providerConfig: { baseUrl: "https://private.example.invalid/router/v1///" } },
    {
      config: providerConfig({ baseUrl: "https://private.example.invalid/router/v1/", models: [] }),
    },
  ])("resolves dynamic proxy destinations from %j", (config) => {
    const model = provider.resolveDynamicModel?.({
      ...dynamicContext("private/unknown-model"),
      ...config,
    } as never);

    expect(model?.baseUrl).toBe("https://private.example.invalid/router/v1");
  });

  it("does not start authenticated catalog discovery when no credential exists", async () => {
    const catalogSpy = vi.spyOn(openRouterCatalog, "buildOpenrouterLiveProvider");

    try {
      await expect(
        provider.catalog?.run({
          config: providerConfig({ baseUrl: "https://private.example.invalid/v1", models: [] }),
          resolveProviderApiKey: () => ({}),
        } as never),
      ).resolves.toBeNull();
      expect(catalogSpy).not.toHaveBeenCalled();
    } finally {
      catalogSpy.mockRestore();
    }
  });

  it("normalizes OpenRouter API ids before capability loading and lookup", async () => {
    const capabilities = {
      name: "Claude Sonnet 4.6",
      reasoning: true,
      compat: { supportedReasoningEfforts: ["high", "low"] },
      thinkingLevelMap: { off: null },
      input: ["text", "image"],
      supportsTools: true,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    };
    loadedCapabilities.mockReturnValue(capabilities);
    const modelId = "openrouter/anthropic/claude-sonnet-4.6";
    const context = dynamicContext(modelId);

    await provider.prepareDynamicModel?.(context);
    const model = provider.resolveDynamicModel?.(context);

    expect(loadCapabilities).toHaveBeenCalledWith("anthropic/claude-sonnet-4.6");
    expect(loadedCapabilities).toHaveBeenCalledWith("anthropic/claude-sonnet-4.6");
    const { supportsTools, ...expected } = capabilities;
    expect(model).toMatchObject({
      ...expected,
      id: modelId,
      compat: { ...capabilities.compat, supportsTools },
    });
  });

  it.each(["typesafe/jev-1.13", "typesafe/jev-1.14", "openrouter/~typesafe/jev-latest"])(
    "keeps %s out of dynamic chat resolution",
    async (modelId) => {
      const context = dynamicContext(modelId);
      await provider.prepareDynamicModel?.(context);
      expect(provider.resolveDynamicModel?.(context)).toBeUndefined();
      expect(loadCapabilities).not.toHaveBeenCalled();
      expect(loadedCapabilities).not.toHaveBeenCalled();
    },
  );

  it("keeps native OpenRouter namespace ids for capability lookup", async () => {
    const context = dynamicContext("openrouter/auto");

    await provider.prepareDynamicModel?.(context);
    provider.resolveDynamicModel?.(context);

    expect(loadCapabilities).toHaveBeenCalledWith("openrouter/auto");
    expect(loadedCapabilities).toHaveBeenCalledWith("openrouter/auto");
  });

  it("keeps stale Hunter Alpha configs out of OpenRouter proxy reasoning", () => {
    expect(isOpenRouterProxyReasoningUnsupportedModel("openrouter/hunter-alpha")).toBe(true);
    expect(isOpenRouterProxyReasoningUnsupportedModel("openrouter/hunter-alpha:free")).toBe(true);
    expect(isOpenRouterProxyReasoningUnsupportedModel("openrouter/healer-alpha")).toBe(false);
  });

  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin: openrouterPlugin,
      providerId: "openrouter",
      modelId: "gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
    await expectPassthroughReplayPolicy({
      plugin: openrouterPlugin,
      providerId: "openrouter",
      modelId: "openai/gpt-5.4",
    });
  });

  // #58012: Mistral rejects replayed tool calls without strict9 IDs (HTTP 400).
  describe("OpenRouter Mistral tool_call_id strict9 (#58012)", () => {
    it.each([
      ["unprefixed Mistral", "mistral-large-latest"],
      ["unprefixed Codestral", "codestral-latest"],
      ["unprefixed Devstral", "devstral-small-latest"],
      ["bare mistralai prefix", "mistralai/mistral-large-latest"],
      ["nested openrouter/mistralai", "openrouter/mistralai/mistral-small"],
      ["bare mistral provider prefix", "mistral/mistral-medium"],
    ])("applies strict9 sanitisation for %s", async (_label, modelId) => {
      const policy = provider.buildReplayPolicy?.(hookContext(modelId));

      expect(policy?.sanitizeToolCallIds).toBe(true);
      expect(policy?.toolCallIdMode).toBe("strict9");
    });

    it.each([
      ["Gemini", "gemini-2.5-pro"],
      ["OpenAI", "openai/gpt-5.4"],
      ["Anthropic", "anthropic/claude-sonnet-4-6"],
      ["DeepSeek", "deepseek/deepseek-v4-flash"],
    ])("keeps passthrough policy for %s (no strict9)", async (_label, modelId) => {
      const policy = provider.buildReplayPolicy?.(hookContext(modelId));

      expect(policy?.sanitizeToolCallIds).toBeUndefined();
      expect(policy?.toolCallIdMode).toBeUndefined();
    });
  });

  it("owns native reasoning output mode", async () => {
    expect(provider.resolveReasoningOutputMode?.(hookContext("openai/gpt-5.4"))).toBe("native");
  });

  it("exposes DeepSeek V4 thinking levels through the lightweight policy artifact", () => {
    const profile = resolveThinkingProfile({
      provider: "openrouter",
      modelId: "openrouter/deepseek/deepseek-v4-pro",
    });
    expect(profile?.levels.map((level) => level.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(profile?.defaultLevel).toBe("high");
    expect(resolveThinkingProfile({ provider: "openrouter", modelId: "openai/gpt-5.4" })).toBe(
      undefined,
    );
  });

  it("canonicalizes stale OpenRouter /v1 config and transport", () => {
    expect(
      provider.normalizeConfig?.({
        provider: "openrouter",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/v1/",
          models: [],
        },
      } as never)?.baseUrl,
    ).toBe(API);
    expect(
      provider.normalizeTransport?.({
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/v1",
      } as never),
    ).toEqual({ api: "openai-completions", baseUrl: API });
  });

  it("normalizes runtime model metadata", () => {
    for (const [model, expected] of [
      [runtimeModel("openai/gpt-5.4", { baseUrl: "https://openrouter.ai/v1" }), { baseUrl: API }],
      [
        runtimeModel("openrouter/hunter-alpha"),
        { id: "openrouter/hunter-alpha", reasoning: false },
      ],
      [
        runtimeModel("openrouter/anthropic/claude-sonnet-4.6"),
        { id: "anthropic/claude-sonnet-4.6" },
      ],
      [runtimeModel("openrouter/auto", { reasoning: false }), undefined],
      [runtimeModel("openrouter/openrouter/auto", { reasoning: false }), { id: "openrouter/auto" }],
    ] as const) {
      const normalized = provider.normalizeResolvedModel?.({
        provider: "openrouter",
        modelId: model.id,
        model,
      });
      if (expected) {
        expect(normalized).toMatchObject(expected);
      } else {
        expect(normalized).toBeUndefined();
      }
    }
  });

  it("injects provider routing into compat before applying stream wrappers", async () => {
    const { payload, model } = await captureStream({
      modelId: "openai/gpt-5.4",
      extraParams: { provider: { order: ["moonshot"] } },
      thinkingLevel: "high",
      payload: {},
    });
    expect(model?.compat).toMatchObject({ openRouterRouting: { order: ["moonshot"] } });
    expect(payload?.provider).toEqual({ order: ["moonshot"] });
  });

  it("forwards resolved API keys as explicit OpenRouter auth headers", async () => {
    const { options } = await captureStream({
      modelId: "openrouter/auto",
      baseUrl: API,
      payload: {},
      options: { apiKey: "or-test-key" },
    });
    const headers = new Headers(options?.headers);
    expect(headers.get("authorization")).toBe("Bearer or-test-key");
  });

  it("merges resolved OpenRouter model params into transport params", async () => {
    const patch = provider.extraParamsForTransport?.({
      config: providerConfig({ params: { provider: { sort: "price", data_collection: "deny" } } }),
      provider: "openrouter",
      modelId: "openai/gpt-5.4",
      extraParams: { provider: { sort: "latency", require_parameters: true }, temperature: 0.2 },
      model: {
        provider: "openrouter",
        api: "openai-completions",
        id: "openai/gpt-5.4",
        params: {
          responseCache: true,
          provider: { order: ["openai"], constructor: "ignored" },
        },
      },
      transport: "sse",
    } as never)?.patch;

    expect(patch).toEqual({
      responseCache: true,
      temperature: 0.2,
      provider: {
        sort: "latency",
        data_collection: "deny",
        order: ["openai"],
        require_parameters: true,
      },
    });
  });

  it("does not inject OpenRouter reasoning for Hunter Alpha", async () => {
    const capturedPayload = await capturePayload(
      "openrouter/hunter-alpha",
      "high",
      {},
      { forwardPayload: true },
    );
    expect(capturedPayload).toStrictEqual({});
  });

  it("uses OpenRouter reasoning for DeepSeek V4 replay turns", async () => {
    const messages = [
      { role: "user", content: "read file" },
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function" }] },
      { role: "tool", content: "ok" },
    ];
    const capturedPayload = await capturePayload(
      "deepseek/deepseek-v4-flash",
      "xhigh",
      {
        messages: [...structuredClone(messages), { role: "assistant", content: "done" }],
      },
      { baseUrl: API },
    );
    expectReasoning(capturedPayload, "xhigh");
    expect(capturedPayload?.messages).toEqual([
      ...messages,
      { role: "assistant", content: "done", reasoning_content: "" },
    ]);
  });

  it("clamps DeepSeek effort to supported values", async () => {
    for (const [level, effort] of [
      ["minimal", "high"],
      ["low", "high"],
      ["medium", "high"],
      ["high", "high"],
      ["xhigh", "xhigh"],
      ["max", "xhigh"],
    ]) {
      const payload = { reasoning: { effort: "high" }, messages: [] };
      await capturePayload(`openrouter/${DEEPSEEK}`, level, payload, { baseUrl: API });
      expectReasoning(payload, effort);
    }
  });

  it.each([
    [`openrouter/${DEEPSEEK}`, API],
    [DEEPSEEK, PROXY],
  ])("preserves tool-call messages for %s at %s", async (modelId, baseUrl) => {
    const messages = [{ role: "assistant", tool_calls: [{ id: "call_1", type: "function" }] }];
    const payload = await capturePayload(
      modelId,
      "high",
      { messages: structuredClone(messages) },
      { baseUrl },
    );
    expect(payload?.messages).toEqual(messages);
  });

  const prefill = [
    { role: "user", content: "Return JSON." },
    { role: "assistant", content: "{" },
  ];
  const toolUse = [
    prefill[0],
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: {} }],
    },
  ];
  it.each([
    ["tool use", toolUse, "high", API, { effort: "high" }],
    ["disabled reasoning", prefill, "off", API, undefined],
    ["custom route", prefill, "high", PROXY, { effort: "high" }],
    ["explicitly disabled reasoning", prefill, "off", API, { enabled: false }],
  ] as const)(
    "preserves Anthropic messages: %s",
    async (name, messages, level, baseUrl, reasoning) => {
      const input = {
        messages: structuredClone(messages),
        ...(name === "explicitly disabled reasoning" ? { reasoning } : {}),
      };
      const payload = await capturePayload("anthropic/claude-opus-4.6", level, input, { baseUrl });
      expect(payload?.messages).toEqual(messages);
      if (reasoning) {
        expect(payload?.reasoning).toEqual(reasoning);
      } else {
        expect(payload).not.toHaveProperty("reasoning");
      }
    },
  );

  function deepSeekModel(compat: Parameters<StreamFn>[0]["compat"] = {}): Parameters<StreamFn>[0] {
    return runtimeModel(DEEPSEEK, {
      api: "openclaw-provider-simple:synthetic",
      compat,
    });
  }

  function standalone(
    model: Parameters<StreamFn>[0],
    thinkingLevel?: Parameters<
      NonNullable<typeof provider.wrapSimpleCompletionStreamFn>
    >[0]["thinkingLevel"],
  ) {
    const requests: Record<string, unknown>[] = [];
    const streamFn: StreamFn = async (currentModel, context, options) => {
      const payload = buildOpenAICompletionsParams(
        { ...currentModel, api: "openai-completions" },
        context,
        options,
      );
      await options?.onPayload?.(payload, currentModel);
      requests.push(payload);
      return createAssistantMessageEventStream();
    };
    const wrapped = provider.wrapSimpleCompletionStreamFn?.({
      provider: "openrouter",
      modelId: model.id,
      model,
      sourceApi: "openai-completions",
      thinkingLevel,
      streamFn,
    });
    if (!wrapped) {
      throw new Error("Missing standalone wrapper");
    }
    return {
      requests,
      send: (context: Parameters<StreamFn>[1], options?: Parameters<StreamFn>[2]) =>
        wrapped(model, context, options),
    };
  }

  describe("OpenRouter chat owner invariants", () => {
    it.each([false, true])(
      "reads per-request DeepSeek effort (catalog=%s)",
      async (hasEffortMetadata) => {
        const model = deepSeekModel(hasEffortMetadata ? EFFORTS : {});
        const { requests, send } = standalone(model);
        for (const reasoning of ["off", "max", undefined] as const) {
          await send({ messages: [] }, { reasoning });
        }
        expect(requests.map((request) => request.reasoning)).toEqual([
          { effort: "none" },
          { effort: "xhigh" },
          { effort: "high" },
        ]);
      },
    );

    it("preserves default-on DeepSeek replay when effort is omitted", async () => {
      const messages = [
        { role: "assistant", content: "Earlier answer", reasoning_content: "Synthetic reasoning" },
      ];
      const payload = await capturePayload(
        DEEPSEEK,
        undefined,
        { messages: structuredClone(messages) },
        { baseUrl: API, compat: EFFORTS },
      );
      expect(payload).not.toHaveProperty("reasoning");
      expect(payload?.messages).toEqual(messages);
    });

    it.each(["auto", "openrouter/auto"])(
      "omits standalone automatic reasoning for %s",
      async (modelId) => {
        const model = runtimeModel(modelId, {
          api: "openclaw-provider-simple:synthetic",
          reasoning: false,
        });
        const { requests, send } = standalone(model, "high");
        await send({ messages: [] }, { reasoning: "high" });
        const payload = requests[0];
        expect(payload?.model).toBe(modelId);
        expect(payload).not.toHaveProperty("reasoning");
        expect(payload).not.toHaveProperty("reasoning_effort");
      },
    );

    it.each(["off", "high"] as const)(
      "applies standalone DeepSeek replay with reasoning %s",
      async (thinkingLevel) => {
        const model: Parameters<StreamFn>[0] = {
          ...deepSeekModel(EFFORTS),
          thinkingLevelMap: { off: "none" },
        };
        const { requests, send } = standalone(model, thinkingLevel);
        await send(
          {
            messages: [
              { role: "user", content: "Start the fixture.", timestamp: 1 },
              {
                role: "assistant",
                provider: "openrouter",
                model: model.id,
                api: "openai-completions",
                content:
                  thinkingLevel === "off"
                    ? [
                        {
                          type: "thinking",
                          thinking: "earlier reasoning",
                          thinkingSignature: "reasoning_content",
                        },
                        { type: "text", text: "Ready." },
                      ]
                    : [{ type: "text", text: "Ready." }],
                usage: createZeroUsageFixture(),
                stopReason: "stop",
                timestamp: 2,
              },
              { role: "user", content: "Continue the fixture.", timestamp: 3 },
            ],
          },
          { reasoning: thinkingLevel },
        );

        expectReasoning(requests[0], thinkingLevel === "off" ? "none" : "high");
        expect(requests[0]?.messages).toEqual(
          expect.arrayContaining([
            thinkingLevel === "off"
              ? { role: "assistant", content: "Ready." }
              : { role: "assistant", content: "Ready.", reasoning_content: "" },
          ]),
        );
      },
    );

    it.each([
      "openrouter/anthropic/claude-sonnet-5",
      "openrouter/deepseek/deepseek-v4-pro",
      "openrouter/moonshotai/kimi-k3",
      "z-ai/glm-5.2",
      "openrouter/z-ai/glm-5.2",
      "~anthropic/claude-opus-latest",
      "~moonshotai/kimi-latest",
      "x-ai/grok-4-1-fast",
      "openrouter/x-ai/grok-4-1-fast",
      "google/gemini-2.5-pro",
      "openrouter/google/gemini-3.1-pro-preview",
    ])("recognizes the live upstream cacheable model reference %s", async (modelId) => {
      expect(provider.isCacheTtlEligible?.({ provider: "openrouter", modelId } as never)).toBe(
        true,
      );
    });

    it.each([
      "openai/gpt-5.4",
      "~openai/gpt-5.4",
      "openrouter/openai/gpt-5.4",
      // OpenRouter documents implicit Gemini caching only for 2.5 and newer.
      "google/gemini-2.0-flash-001",
      "google/gemma-3-27b-it",
    ])(
      "does not infer provider cache support for unrelated model reference %s",
      async (modelId) => {
        expect(provider.isCacheTtlEligible?.({ provider: "openrouter", modelId } as never)).toBe(
          false,
        );
      },
    );

    it.each(["~anthropic/claude-opus-latest", "openrouter/~anthropic/claude-opus-latest"])(
      "strips reasoning prefill for alias %s",
      async (modelId) => {
        const payload = await capturePayload(
          modelId,
          "high",
          {
            reasoning: { effort: "high" },
            messages: structuredClone(prefill),
          },
          { baseUrl: API },
        );
        expect(payload?.messages).toEqual([prefill[0]]);
        expect(payload?.reasoning).toEqual({ effort: "high" });
      },
    );

    it("recognizes the live dated DeepSeek V4 model in its owner thinking profile", async () => {
      expect(
        provider.resolveThinkingProfile?.({
          provider: "openrouter",
          modelId: "deepseek/deepseek-v4-flash-0731",
        } as never),
      ).toMatchObject({ defaultLevel: "high" });
    });

    it.each(["deepseek/deepseek-v4-flash-0731", "deepseek/deepseek-v4.1-flash-1017"])(
      "backfills reasoning replay for dated model %s",
      async (modelId) => {
        const payload = await capturePayload(
          modelId,
          "high",
          {
            messages: [{ role: "assistant", content: "done" }],
          },
          { baseUrl: API },
        );

        expect(payload?.reasoning).toEqual({ effort: "high" });
        expect(payload?.messages).toEqual([
          { role: "assistant", content: "done", reasoning_content: "" },
        ]);
      },
    );
  });

  function resolveContribution(agents: OpenClawConfig["agents"], agentId?: string) {
    return provider.resolveSystemPromptContribution?.({
      provider: "openrouter",
      modelId: "openrouter/fusion",
      promptMode: "full",
      config: { agents },
      agentId,
    });
  }

  function fusionModels(fields: Record<string, unknown>, key = "openrouter/fusion") {
    return { [key]: modelEntry(fusionBody(fields)) };
  }
  function modelEntry(extraBody: Record<string, unknown>) {
    return { params: { extraBody } };
  }
  function fusionBody(fields: Record<string, unknown>) {
    return { plugins: [{ id: "fusion", ...fields }] };
  }

  it("keeps bounded Fusion model IDs on valid UTF-16 boundaries", () => {
    const boundaryModelId = `${"a".repeat(255)}😀tail`;
    const contribution = resolveContribution({
      defaults: {
        models: fusionModels(
          { analysis_models: [boundaryModelId], model: boundaryModelId },
          "openrouter/openrouter/fusion",
        ),
      },
    });

    expect(contribution?.dynamicSuffix).toContain(`Analysis models: ${"a".repeat(255)}.`);
    expect(contribution?.dynamicSuffix).toContain(`Final Fusion model: ${"a".repeat(255)}.`);
  });

  it("matches transport alias precedence for Fusion extra body", () => {
    const contribution = resolveContribution({
      defaults: {
        params: { extra_body: fusionBody({ analysis_models: ["analysis/a"] }) },
        models: fusionModels({ analysis_models: ["analysis/b"] }),
      },
    });

    expect(contribution?.dynamicSuffix).toContain("Analysis models: analysis/a.");
    expect(contribution?.dynamicSuffix).not.toContain("analysis/b");
  });

  it("reads per-agent Fusion config from the canonical agent roster", () => {
    const contribution = resolveContribution(
      { entries: { reviewer: modelEntry(fusionBody({ analysis_models: ["analysis/b"] })) } },
      "reviewer",
    );

    expect(contribution?.dynamicSuffix).toContain("Analysis models: analysis/b.");
  });

  it("uses the bound agent's model-specific Fusion configuration", () => {
    const contribution = resolveContribution(
      {
        defaults: { models: fusionModels({ model: "default/model" }) },
        entries: {
          reviewer: {
            models: fusionModels({ model: "reviewer/model" }, "openrouter/openrouter/fusion"),
          },
        },
      },
      "reviewer",
    );

    expect(contribution?.dynamicSuffix).toContain("Final Fusion model: reviewer/model.");
    expect(contribution?.dynamicSuffix).not.toContain("default/model");
  });

  it.each([
    {
      metadata: { private: "do-not-render" },
      plugins: [{ id: "not-fusion", model: "private-model" }],
    },
    fusionBody({ enabled: false, analysis_models: ["analysis/b"], model: "final/model" }),
  ])("omits non-Fusion and disabled extraBody from the prompt: %j", (extraBody) => {
    const contribution = resolveContribution({
      defaults: { models: { "openrouter/openrouter/fusion": modelEntry(extraBody) } },
    });

    expect(contribution).toBeUndefined();
  });
});
