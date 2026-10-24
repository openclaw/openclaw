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
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { buildOpenrouterProvider } from "./provider-catalog.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";
const API = "https://openrouter.ai/api/v1";
const DEEPSEEK = "deepseek/deepseek-v4-pro";
const PROXY = "https://proxy.example.com/v1";
const AUTO = "openrouter/auto";
const HUNTER = "openrouter/hunter-alpha";
const CLAUDE = "anthropic/claude-sonnet-4.6";
type Model = Parameters<StreamFn>[0];
const EFFORTS: NonNullable<Parameters<StreamFn>[0]["compat"]> = {
  supportedReasoningEfforts: ["none", "high", "xhigh"],
};
let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
beforeEach(async () => {
  loadedCapabilities.mockReset();
  loadCapabilities.mockClear();
  provider = await registerSingleProviderPlugin(openrouterPlugin);
});
afterEach(() => vi.restoreAllMocks());

function runtimeModel(id: string, overrides: Partial<Model> = {}): Model {
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
  options?: Parameters<StreamFn>[2];
}) {
  const model = runtimeModel(params.modelId, {
    baseUrl: params.baseUrl ?? API,
    compat: params.compat ?? {},
  });
  const run = streamHarness(model, params.thinkingLevel, params.payload, params.extraParams);
  let payload: Record<string, unknown> | undefined;
  await run.send(
    { messages: [] },
    {
      ...params.options,
      onPayload: (value) => {
        payload = value as Record<string, unknown>;
      },
    },
  );
  return { payload, options: run.options[0] };
}

function streamHarness(
  model: Parameters<StreamFn>[0],
  thinkingLevel?: string,
  fixture?: Record<string, unknown>,
  extraParams?: Record<string, unknown>,
  simple = false,
) {
  const requests: Record<string, unknown>[] = [];
  const options: Parameters<StreamFn>[2][] = [];
  const streamFn: StreamFn = async (current, context, opts) => {
    const payload =
      fixture ??
      buildOpenAICompletionsParams({ ...current, api: "openai-completions" }, context, opts);
    await opts?.onPayload?.(payload, current);
    requests.push(payload);
    options.push(opts);
    return createAssistantMessageEventStream();
  };
  const wrap = simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const wrapped = wrap?.({
    provider: "openrouter",
    modelId: model.id,
    model,
    sourceApi: simple ? "openai-completions" : undefined,
    thinkingLevel,
    extraParams,
    streamFn,
  } as never);
  if (!wrapped) {
    throw new Error("Missing OpenRouter wrapper");
  }
  return {
    requests,
    options,
    send: (context: Parameters<StreamFn>[1], opts?: Parameters<StreamFn>[2]) =>
      wrapped(model, context, opts),
  };
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
  it("registers OpenRouter speech alongside model, media, and catalog providers", async () => {
    expect(manifest.modelCatalog?.discovery).toEqual({ openrouter: "runtime" });
    expect(provider.resolveReasoningOutputMode?.(hookContext("openai/gpt-5.4"))).toBe("native");
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
      expect(registered[key].map((entry) => entry.id)).toEqual(["openrouter"]);
    }
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
    for (const [choice, id, kind] of [
      ["openrouter", "api-key", "api_key"],
      ["openrouter-oauth", "oauth", "oauth"],
    ]) {
      expect(resolveProviderPluginChoice({ providers: [provider], choice })?.method).toMatchObject({
        id,
        kind,
      });
    }
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

  it.each([true, false])("gates proxy discovery on credentials: %s", async (authenticated) => {
    const configuredProvider = {
      baseUrl: "https://private.example.invalid/router/v1///",
      request: { headers: { "X-Private-Proxy-Tenant": "synthetic-tenant" } },
    };
    const catalogSpy = vi
      .spyOn(openRouterCatalog, "buildOpenrouterLiveProvider")
      .mockResolvedValue(buildOpenrouterProvider());

    const result = await provider.catalog?.run({
      config: providerConfig(configuredProvider),
      resolveProviderApiKey: () =>
        authenticated
          ? {
              apiKey: "OPENROUTER_API_KEY",
              discoveryApiKey: "synthetic-private-proxy-key",
            }
          : {},
    } as never);
    if (authenticated) {
      expect(catalogSpy).toHaveBeenCalledWith(expect.objectContaining(configuredProvider));
    } else {
      expect(result).toBeNull();
      expect(catalogSpy).not.toHaveBeenCalled();
    }
  });

  it.each([
    { providerConfig: { baseUrl: "https://private.example.invalid/router/v1///" } },
    {
      config: providerConfig({ baseUrl: "https://private.example.invalid/router/v1/" }),
    },
  ])("resolves dynamic proxy destinations from %j", (config) => {
    const model = provider.resolveDynamicModel?.({
      ...dynamicContext("private/unknown-model"),
      ...config,
    } as never);

    expect(model?.baseUrl).toBe("https://private.example.invalid/router/v1");
  });

  it.each([
    [`openrouter/${CLAUDE}`, CLAUDE],
    [AUTO, AUTO],
  ])("loads capabilities for %s using %s", async (modelId, apiId) => {
    loadedCapabilities.mockReturnValue({
      reasoning: true,
      compat: { supportedReasoningEfforts: ["high", "low"] },
      thinkingLevelMap: { off: null },
      supportsTools: true,
    });
    const context = dynamicContext(modelId);
    await provider.prepareDynamicModel?.(context);
    const model = provider.resolveDynamicModel?.(context);
    expect(loadCapabilities).toHaveBeenCalledWith(apiId);
    expect(loadedCapabilities).toHaveBeenCalledWith(apiId);
    expect(model).toMatchObject({
      id: modelId,
      reasoning: true,
      compat: { supportedReasoningEfforts: ["high", "low"], supportsTools: true },
      thinkingLevelMap: { off: null },
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

  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin: openrouterPlugin,
      providerId: "openrouter",
      modelId: "gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
  });

  // #58012: Mistral rejects replayed tool calls without strict9 IDs (HTTP 400).
  it.each(["mistral-large-latest", "openrouter/mistralai/mistral-small"])(
    "applies strict9 sanitisation for %s",
    (modelId) => {
      const policy = provider.buildReplayPolicy?.(hookContext(modelId));
      expect(policy).toMatchObject({ sanitizeToolCallIds: true, toolCallIdMode: "strict9" });
    },
  );

  it("keeps non-Mistral passthrough policy", () => {
    const policy = provider.buildReplayPolicy?.(hookContext("openai/gpt-5.4"));
    expect(policy?.sanitizeToolCallIds).toBeUndefined();
    expect(policy?.toolCallIdMode).toBeUndefined();
  });

  it.each([
    ["artifact", `openrouter/${DEEPSEEK}`],
    ["registered hook", "deepseek/deepseek-v4-flash-0731"],
  ])("exposes the thinking profile via %s", (owner, modelId) => {
    const context = { provider: "openrouter", modelId };
    const profile =
      owner === "artifact"
        ? resolveThinkingProfile(context)
        : provider.resolveThinkingProfile?.(context);
    const levels = profile?.levels.map((level) => level.id);
    expect(levels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    expect(profile?.defaultLevel).toBe("high");
  });
  it("does not use the DeepSeek profile for unrelated models", () => {
    expect(
      resolveThinkingProfile({ provider: "openrouter", modelId: "openai/gpt-5.4" }),
    ).toBeUndefined();
  });

  it("canonicalizes stale OpenRouter /v1 config and transport", () => {
    expect(
      provider.normalizeConfig?.({
        providerConfig: { baseUrl: "https://openrouter.ai/v1/" },
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
      [runtimeModel(HUNTER), { id: HUNTER, reasoning: false }],
      [runtimeModel(`openrouter/${CLAUDE}`), { id: CLAUDE }],
      [runtimeModel(AUTO, { reasoning: false }), undefined],
      [runtimeModel(`openrouter/${AUTO}`, { reasoning: false }), { id: AUTO }],
    ] as const) {
      const normalized = provider.normalizeResolvedModel?.({
        provider: "openrouter",
        modelId: model.id,
        model,
      });
      expect(normalized).toEqual(expected ? expect.objectContaining(expected) : undefined);
    }
  });

  it("injects provider routing into compat before applying stream wrappers", async () => {
    const { payload } = await captureStream({
      modelId: "openai/gpt-5.4",
      extraParams: { provider: { order: ["moonshot"] } },
      thinkingLevel: "high",
      payload: {},
    });
    expect(payload?.provider).toEqual({ order: ["moonshot"] });
  });

  it.each([API, ""])("forwards resolved keys as auth headers (route=%s)", async (baseUrl) => {
    const { options } = await captureStream({
      modelId: AUTO,
      baseUrl,
      payload: {},
      options: { apiKey: "or-test-key" },
    });
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer or-test-key");
  });

  it("merges resolved OpenRouter model params into transport params", async () => {
    const patch = provider.extraParamsForTransport?.({
      config: providerConfig({ params: { provider: { sort: "price", data_collection: "deny" } } }),
      provider: "openrouter",
      modelId: "openai/gpt-5.4",
      extraParams: { provider: { sort: "latency", require_parameters: true }, temperature: 0.2 },
      model: {
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

  it.each([HUNTER, `${HUNTER}:free`])("does not inject reasoning for %s", async (modelId) => {
    const capturedPayload = await capturePayload(modelId, "high", {});
    expect(capturedPayload).toStrictEqual({});
  });

  it("uses OpenRouter reasoning for DeepSeek V4 replay turns", async () => {
    const messages = [
      { role: "user", content: "read file" },
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function" }] },
      { role: "tool", content: "ok" },
    ];
    const capturedPayload = await capturePayload("deepseek/deepseek-v4-flash", "xhigh", {
      messages: [...structuredClone(messages), { role: "assistant", content: "done" }],
    });
    expectReasoning(capturedPayload, "xhigh");
    expect(capturedPayload?.messages).toEqual([
      ...messages,
      { role: "assistant", content: "done", reasoning_content: "" },
    ]);
  });

  it("clamps DeepSeek effort to supported values", async () => {
    for (const [level, effort] of [
      ["minimal", "high"],
      ["max", "xhigh"],
    ]) {
      const payload = { reasoning: { effort: "high" }, messages: [] };
      await capturePayload(`openrouter/${DEEPSEEK}`, level, payload);
      expectReasoning(payload, effort);
    }
  });

  it("does not patch tool-call messages on a custom route", async () => {
    const messages = [{ role: "assistant", tool_calls: [{ id: "call_1", type: "function" }] }];
    const payload = await capturePayload(
      DEEPSEEK,
      "high",
      { messages: structuredClone(messages) },
      { baseUrl: PROXY },
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

  function standalone(model: Parameters<StreamFn>[0], thinkingLevel?: string) {
    return streamHarness(model, thinkingLevel, undefined, undefined, true);
  }

  it.each([false, true])(
    "reads per-request DeepSeek effort (catalog=%s)",
    async (hasEffortMetadata) => {
      const model = runtimeModel(DEEPSEEK, {
        api: "openclaw-provider-simple:synthetic",
        compat: hasEffortMetadata ? EFFORTS : {},
        thinkingLevelMap: { off: "none" },
      });
      const { requests, send } = standalone(model);
      for (const reasoning of ["off", "max", undefined] as const) {
        await send(
          {
            messages: [
              { role: "user", content: "Start.", timestamp: 1 },
              makeAgentAssistantMessage({
                timestamp: 2,
                provider: "openrouter",
                model: model.id,
                api: "openai-completions",
                content:
                  reasoning === "off"
                    ? [
                        {
                          type: "thinking",
                          thinking: "earlier reasoning",
                          thinkingSignature: "reasoning_content",
                        },
                        { type: "text", text: "Ready." },
                      ]
                    : [{ type: "text", text: "Ready." }],
              }),
              { role: "user", content: "Continue.", timestamp: 3 },
            ],
          },
          { reasoning },
        );
        expect(requests.at(-1)?.messages).toEqual(
          expect.arrayContaining([
            reasoning === "off"
              ? { role: "assistant", content: "Ready." }
              : { role: "assistant", content: "Ready.", reasoning_content: "" },
          ]),
        );
        expect(requests.at(-1)).not.toHaveProperty("thinking");
        expect(requests.at(-1)).not.toHaveProperty("reasoning_effort");
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
      { compat: EFFORTS },
    );
    expect(payload).not.toHaveProperty("reasoning");
    expect(payload?.messages).toEqual(messages);
  });

  it.each(["auto", "openrouter/auto"])("omits standalone reasoning for %s", async (modelId) => {
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
  });

  it.each([
    ["~anthropic/claude-opus-latest", true],
    ["openrouter/deepseek/deepseek-v4-pro", true],
    ["openrouter/moonshotai/kimi-k3", true],
    ["z-ai/glm-5.2", true],
    ["x-ai/grok-4-1-fast", true],
    ["google/gemini-2.5-pro", true],
    ["openrouter/google/gemini-3.1-pro-preview", true],
    ["openrouter/openai/gpt-5.4", false],
    ["google/gemini-2.0-flash-001", false],
    ["google/gemma-3-27b-it", false],
  ] as const)("cache TTL eligibility for %s: %s", (modelId, eligible) => {
    expect(provider.isCacheTtlEligible?.({ provider: "openrouter", modelId })).toBe(eligible);
  });

  it.each(["~anthropic/claude-opus-latest", "openrouter/~anthropic/claude-opus-latest"])(
    "strips reasoning prefill for alias %s",
    async (modelId) => {
      const payload = await capturePayload(modelId, "high", {
        reasoning: { effort: "high" },
        messages: structuredClone(prefill),
      });
      expect(payload?.messages).toEqual([prefill[0]]);
      expect(payload?.reasoning).toEqual({ effort: "high" });
    },
  );

  it.each(["deepseek/deepseek-v4-flash-0731", "deepseek/deepseek-v4.1-flash-1017"])(
    "backfills reasoning replay for dated model %s",
    async (modelId) => {
      const payload = await capturePayload(modelId, "high", {
        messages: [{ role: "assistant", content: "done" }],
      });

      expect(payload?.reasoning).toEqual({ effort: "high" });
      expect(payload?.messages).toEqual([
        { role: "assistant", content: "done", reasoning_content: "" },
      ]);
    },
  );
  function contribution(agents: OpenClawConfig["agents"], agentId?: string) {
    return provider.resolveSystemPromptContribution?.({
      provider: "openrouter",
      modelId: "openrouter/fusion",
      promptMode: "full",
      config: { agents },
      agentId,
    });
  }

  function fusionConfig(fields: Record<string, unknown>, key = "openrouter/fusion") {
    return { models: { [key]: modelEntry(fusionBody(fields)) } };
  }
  function modelEntry(extraBody: Record<string, unknown>) {
    return { params: { extraBody } };
  }
  function fusionBody(fields: Record<string, unknown>) {
    return { plugins: [{ id: "fusion", ...fields }] };
  }

  it("keeps bounded Fusion model IDs on valid UTF-16 boundaries", () => {
    const boundaryModelId = `${"a".repeat(255)}😀tail`;
    const suffix = contribution({
      defaults: fusionConfig(
        { analysis_models: [boundaryModelId], model: boundaryModelId },
        "openrouter/openrouter/fusion",
      ),
    })?.dynamicSuffix;

    expect(suffix).toContain(`Analysis models: ${"a".repeat(255)}.`);
    expect(suffix).toContain(`Final Fusion model: ${"a".repeat(255)}.`);
  });

  it.each([
    [{ extra_body: fusionBody({ analysis_models: ["a"] }) }, {}, "Analysis models: a.", "b."],
    [{}, modelEntry(fusionBody({ analysis_models: ["agent"] })), "Analysis models: agent.", "b."],
    [
      {},
      fusionConfig({ model: "reviewer" }, "openrouter/openrouter/fusion"),
      "Final Fusion model: reviewer.",
      "default",
    ],
  ] as const)("resolves Fusion precedence: %s", (params, reviewer, included, excluded) => {
    const suffix = contribution(
      {
        defaults: { ...fusionConfig({ analysis_models: ["b"], model: "default" }), params },
        entries: { reviewer },
      },
      "reviewer",
    )?.dynamicSuffix;
    expect(suffix).toContain(included);
    expect(suffix).not.toContain(excluded);
  });

  it.each([
    {
      metadata: { private: "do-not-render" },
      plugins: [{ id: "not-fusion", model: "private-model" }],
    },
    fusionBody({ enabled: false, analysis_models: ["analysis/b"], model: "final/model" }),
  ])("omits non-Fusion and disabled extraBody from the prompt: %j", (extraBody) => {
    const suffix = contribution({
      defaults: { models: { "openrouter/openrouter/fusion": modelEntry(extraBody) } },
    });

    expect(suffix).toBeUndefined();
  });
});
