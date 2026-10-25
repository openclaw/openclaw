import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type {
  ProviderCatalogContext,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { NON_ENV_SECRETREF_MARKER } from "openclaw/plugin-sdk/provider-auth-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildOpencodeGoLiveProviderConfig,
  buildStaticOpencodeGoProviderConfig,
  resolveOpencodeGoStarterModel,
} from "./provider-catalog.js";
import opencodeGoProviderDiscovery from "./provider-discovery.js";

function expectDeprecated(entries: unknown, id: string) {
  expect(entries).toContainEqual(expect.objectContaining({ id, status: "deprecated" }));
}

const OPENAI_URL = "https://opencode.ai/inference/go/openai/v1";
const ANTHROPIC_URL = "https://opencode.ai/inference/go/anthropic";
const LEGACY_URL = "https://opencode.ai/zen/go/v1";
const NO_REASONING = { reasoning: false, compat: { supportsReasoningEffort: false } };
const assistant = (content: unknown, fields = {}) => ({ role: "assistant", content, ...fields });
const text = (value: string) => ({ type: "text", text: value });
const thinking = () => ({ type: "thinking", reasoning_details: [{ text: "private thought" }] });

const ACTIVE_MODEL_IDS = manifest.modelCatalog.providers["opencode-go"].models
  .filter((model) => !("status" in model))
  .map((model) => model.id);

function makeRuntimeModel(id: string, overrides: Partial<Parameters<StreamFn>[0]> = {}) {
  return {
    id,
    name: id,
    provider: "opencode-go",
    api: "openai-completions",
    baseUrl: LEGACY_URL,
    reasoning: true,
    input: ["text"],
    contextWindow: 262_144,
    maxTokens: 65_536,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  } satisfies Parameters<StreamFn>[0];
}

function upstreamModel(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text"] },
    limit: { context: 262_144, output: 32_768 },
    cost: { input: 0, output: 0 },
    ...overrides,
  };
}

async function captureGoWirePayload(
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
  payload: Record<string, unknown> & { model: string },
  sourceApi: "openai-completions" | "anthropic-messages" = "openai-completions",
) {
  const provider = await registerSingleProviderPlugin(plugin);
  const modelId = payload.model;
  const model = makeRuntimeModel(modelId, {
    api: sourceApi,
    baseUrl: sourceApi === "anthropic-messages" ? "https://opencode.ai/zen/go" : LEGACY_URL,
  });
  const baseStreamFn = vi.fn<StreamFn>((runtimeModel, _context, options) => {
    void options?.onPayload?.(payload, runtimeModel);
    return createAssistantMessageEventStream();
  });
  const streamFn = provider.wrapStreamFn?.({
    streamFn: baseStreamFn,
    provider: "opencode-go",
    modelId,
    model,
    thinkingLevel,
  });
  expect(streamFn).toBeTypeOf("function");
  await streamFn?.(model, { messages: [] }, {});
  expect(baseStreamFn).toHaveBeenCalledOnce();
  return payload;
}

function createCatalogFetchGuard(upstreamModels: Record<string, unknown>, liveModelIds: string[]) {
  const metadata = {
    "opencode-go": {
      id: "opencode-go",
      api: "https://opencode.ai/zen/go/v1",
      npm: "@ai-sdk/openai-compatible",
      models: upstreamModels,
    },
  };
  const listing = { data: liveModelIds.map((id) => ({ id, object: "model" })) };
  return vi.fn(async ({ url }: { url: string; init?: RequestInit }) => ({
    response: Response.json(url === "https://models.opencode.ai/api.json" ? metadata : listing),
    finalUrl: url,
    release: vi.fn(async () => undefined),
  }));
}

function liveCatalog(
  upstreamModels: Record<string, unknown>,
  liveModelIds: string[],
  key = "resolved-opencode-key",
) {
  return buildOpencodeGoLiveProviderConfig({
    discoveryApiKey: key,
    fetchGuard: createCatalogFetchGuard(upstreamModels, liveModelIds),
  });
}

function withFetchSpy(run: (fetchMock: MockInstance<typeof fetch>) => Promise<void>) {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  return run(fetchMock).finally(() => fetchMock.mockRestore());
}

describe("opencode-go provider plugin", () => {
  let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
  beforeEach(async () => {
    clearLiveCatalogCacheForTests();
    provider = await registerSingleProviderPlugin(plugin);
  });

  function runCatalog(
    resolveProviderApiKey: ProviderCatalogContext["resolveProviderApiKey"],
    providerIds?: string[],
  ) {
    return provider.catalog?.run({
      config: {},
      env: {},
      providerIds,
      resolveProviderApiKey,
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });
  }

  const dynamicModel = (modelId: string) => provider.resolveDynamicModel?.({ modelId } as never);
  const catalogEntries = () => provider.augmentModelCatalog?.({ entries: [] } as never);
  const normalizeModel = (model: Parameters<StreamFn>[0]) =>
    provider.normalizeResolvedModel?.({ provider: "opencode-go", modelId: model.id, model });
  const thinkingProfile = (modelId: string, api: string, compat = {}) =>
    provider.resolveThinkingProfile?.({
      provider: "opencode-go",
      modelId,
      api,
      reasoning: true,
      compat,
    });

  function resolveTurnState(
    model = makeRuntimeModel("glm-5"),
    context: { sessionId?: string; turnId?: string } = {},
  ) {
    return provider.resolveTransportTurnState?.({
      provider: model.provider,
      modelId: model.id,
      model,
      sessionId: "conversation-123",
      turnId: "turn-1",
      attempt: 1,
      transport: "stream",
      ...context,
    });
  }

  it.each(["deepseek-v4-pro", "deepseek-v4.1-flash", "kimi-k3"] as const)(
    "keeps %s thinking per invocation on one standalone completion wrapper",
    async (modelId) => {
      const catalog = buildStaticOpencodeGoProviderConfig();
      const entry = catalog.models.find((model) => model.id === modelId);
      if (!entry) {
        throw new Error(`Missing ${modelId} catalog entry`);
      }
      const model = makeRuntimeModel(modelId, {
        ...entry,
        input: entry.input.filter((kind) => kind === "text" || kind === "image"),
        api: "openclaw-provider-simple:synthetic",
        baseUrl: catalog.baseUrl,
      });
      let payload: Record<string, unknown> | undefined;
      const baseStreamFn: StreamFn = async (runtimeModel, context, options) => {
        payload = buildOpenAICompletionsParams(
          { ...runtimeModel, api: "openai-completions" },
          context,
          options,
        );
        await options?.onPayload?.(payload, runtimeModel);
        return createAssistantMessageEventStream();
      };
      const wrapped = provider.wrapSimpleCompletionStreamFn?.({
        provider: "opencode-go",
        modelId: model.id,
        model,
        sourceApi: "openai-completions",
        streamFn: baseStreamFn,
      });
      if (!wrapped) {
        throw new Error("Missing standalone completion wrapper");
      }
      for (const reasoning of ["off", "max", undefined] as const) {
        await wrapped(
          model,
          { messages: [{ role: "user", content: "Synthetic request", timestamp: 1 }] },
          { reasoning },
        );

        if (modelId === "kimi-k3") {
          expect(payload).not.toHaveProperty("thinking");
        } else {
          expect(payload?.thinking).toEqual({ type: reasoning === "off" ? "disabled" : "enabled" });
        }
        const expectedEffort =
          reasoning === "off" ? undefined : modelId === "kimi-k3" ? "max" : (reasoning ?? "high");
        if (expectedEffort === undefined) {
          expect(payload).not.toHaveProperty("reasoning_effort");
        } else {
          expect(payload?.reasoning_effort).toBe(expectedEffort);
        }
      }
    },
  );

  it("keeps offline starter models and provider-owned thinking policies usable", async () => {
    const supplemental = await catalogEntries();

    for (const modelId of ACTIVE_MODEL_IDS) {
      expect(dynamicModel(modelId)).toMatchObject({ id: modelId, provider: "opencode-go" });
    }
    expectDeprecated(supplemental, "deepseek-v4-flash");
    expect(dynamicModel("kimi-k2.6")).toMatchObject({ id: "kimi-k2.6", input: ["text", "image"] });
    expect(dynamicModel("qwen3.8-max")).toMatchObject({
      api: "anthropic-messages",
      baseUrl: ANTHROPIC_URL,
      compat: { thinkingFormat: "qwen" },
    });
    expect(
      thinkingProfile("deepseek-v4-flash", "openai-completions", {
        supportedReasoningEfforts: ["low", "high", "max"],
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }],
      defaultLevel: "high",
    });
    expect(thinkingProfile("minimax-m2.7", "anthropic-messages")).toEqual({
      levels: [{ id: "high", label: "always on" }],
      defaultLevel: "high",
    });
  });

  it("lists every advertised chat model, enriching ids with upstream metadata", async () => {
    const fetchGuard = createCatalogFetchGuard(
      {
        "ox-alpha-free": upstreamModel("ox-alpha-free", {
          name: "Ox Alpha Free (Unlimited)",
          modalities: { input: ["text", "image", "video"] },
          limit: { context: 1_000_000, output: 131_072 },
          reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        }),
        "minimax-future": upstreamModel("minimax-future", {
          provider: { npm: "@ai-sdk/anthropic" },
          cost: { input: 0.3, output: 1.2, cache_read: 0.06 },
        }),
        "legacy-model": upstreamModel("legacy-model", { status: "deprecated" }),
      },
      ["ox-alpha-free", "minimax-future", "legacy-model", "unknown-live-model", "future-embedding"],
    );
    const result = await buildOpencodeGoLiveProviderConfig({
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });

    expect(result.models).toMatchObject([
      {
        id: "ox-alpha-free",
        name: "Ox Alpha Free (Unlimited)",
        api: "openai-completions",
        baseUrl: OPENAI_URL,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        maxTokens: 131_072,
        compat: { supportedReasoningEfforts: ["low", "high", "max"], supportsTools: true },
      },
      {
        id: "minimax-future",
        api: "anthropic-messages",
        baseUrl: ANTHROPIC_URL,
        cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
      },
      {
        id: "unknown-live-model",
        provider: "opencode-go",
        api: "openai-completions",
        baseUrl: OPENAI_URL,
        input: ["text"],
      },
    ]);
    const listingRequest = fetchGuard.mock.calls.find(
      ([request]) => request.url === "https://opencode.ai/inference/go/v1/models",
    )?.[0];
    expect(new Headers(listingRequest?.init?.headers).get("user-agent")).toMatch(/^openclaw\//);
    expect(dynamicModel("legacy-model")).toBeUndefined();
    const supplemental = await catalogEntries();
    expectDeprecated(supplemental, "legacy-model");
    expectDeprecated(supplemental, "deepseek-v4-flash");
  });

  it("never resolves another account's upstream-only Go model outside its authenticated catalog", async () => {
    const upstreamModels = {
      "account-a-only": upstreamModel("account-a-only"),
      "account-b-only": upstreamModel("account-b-only"),
    };
    const accountA = await liveCatalog(upstreamModels, ["account-a-only"], "account-a-key");
    expect(accountA.models.map((model) => model.id)).toEqual(["account-a-only"]);

    const accountB = await liveCatalog(upstreamModels, ["account-b-only"], "account-b-key");
    expect(accountB.models.map((model) => model.id)).toEqual(["account-b-only"]);

    expect(dynamicModel("account-a-only")).toBeUndefined();
    expect(dynamicModel("account-b-only")).toBeUndefined();
    expect(provider.prepareDynamicModel).toBeUndefined();
  });

  it("evicts withdrawn or unsafe upstream models while retaining trusted offline seeds", async () => {
    await expect(
      liveCatalog({ "withdrawn-model": upstreamModel("withdrawn-model") }, ["withdrawn-model"]),
    ).resolves.toMatchObject({ models: [{ id: "withdrawn-model" }] });

    clearLiveCatalogCacheForTests();
    // Rejected metadata cannot redirect inference; the listed id keeps Go's own route.
    await expect(
      liveCatalog(
        {
          "replacement-model": upstreamModel("replacement-model"),
          "unsafe-model": upstreamModel("unsafe-model", {
            provider: { api: "https://attacker.invalid/v1" },
          }),
        },
        ["replacement-model", "unsafe-model"],
      ),
    ).resolves.toMatchObject({
      models: [{ id: "replacement-model" }, { id: "unsafe-model", baseUrl: OPENAI_URL }],
    });

    const entries = await catalogEntries();
    expect(entries?.some((entry) => entry.id === "withdrawn-model")).toBe(false);
    expect(entries?.some((entry) => entry.id === "unsafe-model")).toBe(false);
    expectDeprecated(entries, "kimi-k2.6");
  });

  it("exposes only trusted offline starter models through provider discovery", async () => {
    expect(manifest.providerCatalogEntry).toBe("./provider-discovery.ts");
    expect(manifest.modelCatalog.discovery["opencode-go"]).toBe("runtime");
    const result = await opencodeGoProviderDiscovery.staticCatalog?.run({} as never);
    if (!result || !("provider" in result)) {
      throw new Error("expected OpenCode Go static provider");
    }
    const modelIds = result.provider.models.map((model) => model.id);
    expect(new Set(modelIds).size).toBe(modelIds.length);
    expect(modelIds.toSorted()).toEqual(ACTIVE_MODEL_IDS.toSorted());
    for (const [id, supportedReasoningEfforts] of [
      ["deepseek-v4-pro", ["high", "max"]],
      ["deepseek-v4.1-flash", ["low", "high", "max"]],
    ] as const) {
      expect(result.provider.models.find((model) => model.id === id)).toMatchObject({
        provider: "opencode-go",
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        compat: { supportedReasoningEfforts },
      });
    }
    for (const id of ["hy3-preview", "deepseek-v4-flash", "kimi-k2.6"]) {
      expect(modelIds).not.toContain(id);
    }
  });

  it("skips unrelated scoped discovery even when OpenCode credentials are configured", () =>
    withFetchSpy(async (fetchMock) => {
      const resolveProviderApiKey = vi.fn(() => ({
        apiKey: "configured-opencode-key",
        discoveryApiKey: "configured-opencode-key",
      }));

      await expect(runCatalog(resolveProviderApiKey, ["anthropic"])).resolves.toBeNull();
      expect(resolveProviderApiKey).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      await expect(
        runCatalog(() => ({ apiKey: "configured-opencode-key" }), ["opencode-go"]),
      ).resolves.toMatchObject({
        provider: { apiKey: "configured-opencode-key" },
      });
    }));

  it("never fetches either catalog when no shared OpenCode key is configured", () =>
    withFetchSpy(async (fetchMock) => {
      await expect(runCatalog(() => ({ apiKey: undefined }))).resolves.toBeNull();
      await expect(buildOpencodeGoLiveProviderConfig()).resolves.toMatchObject({
        models: expect.arrayContaining([expect.objectContaining({ id: "deepseek-v4-pro" })]),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }));

  it("does not select an unavailable preferred onboarding model", async () => {
    await expect(
      resolveOpencodeGoStarterModel({
        apiKey: "resolved-opencode-key",
        preferredModelRef: "opencode-go/deepseek-v4-pro",
        fetchGuard: createCatalogFetchGuard({}, ["glm-5.1"]),
      }),
    ).resolves.toBeUndefined();
  });

  it("does not mix provider-specific runtime auth with shared discovery auth", () =>
    withFetchSpy(async (fetchMock) => {
      fetchMock.mockRejectedValue(new Error("blocked fetch"));
      const resolveProviderApiKey = vi.fn((providerId?: string) =>
        providerId === "opencode-go"
          ? { apiKey: NON_ENV_SECRETREF_MARKER, discoveryApiKey: undefined }
          : { apiKey: "shared-opencode-key", discoveryApiKey: "shared-opencode-key" },
      );

      const result = await runCatalog(resolveProviderApiKey);

      expect(result).toMatchObject({
        provider: {
          apiKey: NON_ENV_SECRETREF_MARKER,
          models: expect.arrayContaining([expect.objectContaining({ id: "deepseek-v4-pro" })]),
        },
      });
      expect(resolveProviderApiKey).toHaveBeenCalledExactlyOnceWith("opencode-go");
      expect(fetchMock).not.toHaveBeenCalled();
    }));

  it("does not synthesize a stream when the runtime provides none", async () => {
    expect(provider.wrapStreamFn?.({ streamFn: undefined } as never)).toBeUndefined();
  });

  it("attaches a stable conversation id only to native OpenCode Go requests", async () => {
    for (const turnId of ["turn-1", "turn-2"]) {
      expect(resolveTurnState(makeRuntimeModel("glm-5"), { turnId })).toEqual({
        headers: { "x-opencode-session": "conversation-123" },
      });
    }
    expect(
      resolveTurnState(
        makeRuntimeModel("glm-5", { headers: { "X-OpenCode-Session": "configured-session" } }),
        { sessionId: undefined },
      ),
    ).toBeUndefined();
    expect(
      resolveTurnState(makeRuntimeModel("glm-5", { baseUrl: "https://proxy.example.com/v1" })),
    ).toBeUndefined();
  });

  it("identifies native Anthropic stream and simple requests without tagging proxies", async () => {
    for (const [wrap, runtimeApi, sourceApi] of [
      [provider.wrapStreamFn, "anthropic-messages", undefined],
      [
        provider.wrapSimpleCompletionStreamFn,
        "openclaw-provider-simple:opencode-go:qwen3.8-max",
        "anthropic-messages",
      ],
    ] as const) {
      const capturedHeaders: Array<Record<string, string> | undefined> = [];
      const baseStreamFn: StreamFn = (_model, _context, options) => {
        capturedHeaders.push(options?.headers);
        return createAssistantMessageEventStream();
      };
      const streamFn = wrap?.({
        streamFn: baseStreamFn,
        providerId: "opencode-go",
        modelId: "qwen3.8-max",
        thinkingLevel: "high",
        sourceApi,
      } as never);

      expect(streamFn).toBeTypeOf("function");
      const model = makeRuntimeModel("qwen3.8-max", { api: runtimeApi });
      await streamFn?.(
        { ...model, baseUrl: "https://opencode.ai/zen/go" },
        { messages: [] },
        {
          headers: { "User-Agent": "configured-client/1.0", "X-Custom": "1" },
        },
      );
      await streamFn?.(
        { ...model, baseUrl: "https://proxy.example.com" },
        { messages: [] },
        {
          headers: { "User-Agent": "configured-client/2.0", "X-Custom": "2" },
        },
      );

      expect(capturedHeaders).toEqual([
        { "User-Agent": expect.stringMatching(/^openclaw\//), "X-Custom": "1" },
        { "User-Agent": "configured-client/2.0", "X-Custom": "2" },
      ]);
    }
  });

  it.each([
    ["deepseek-v4-flash", "low"],
    ["deepseek-v4.1-flash", "high"],
    ["deepseek-v4.1-flash", "max"],
  ] as const)("maps %s thinking %s to matching effort", async (modelId, thinkingLevel) => {
    const payload = await captureGoWirePayload(thinkingLevel, { model: modelId });

    expect(payload).toEqual({
      model: modelId,
      thinking: { type: "enabled" },
      reasoning_effort: thinkingLevel,
    });
  });

  it("strips unsupported Kimi reasoning on Go", async () => {
    const payload = await captureGoWirePayload("high", {
      model: "kimi-k2.6",
      reasoning_effort: "high",
      reasoning: { effort: "high" },
      reasoningEffort: "high",
      messages: [
        assistant("done", { reasoning_content: "earlier reasoning" }),
        assistant([text("done"), thinking(), { type: "redacted_thinking", data: "opaque" }], {
          reasoning_details: [{ text: "private thought" }],
          reasoning_content: "private thought",
          reasoning_text: "private thought",
        }),
      ],
      input: [
        { type: "reasoning", summary: [] },
        assistant("done", { reasoning_details: [] }),
        assistant([thinking()]),
      ],
    });

    expect(payload).toEqual({
      model: "kimi-k2.6",
      messages: [assistant("done"), assistant([text("done")])],
      input: [assistant("done"), assistant([text("[assistant reasoning omitted]")])],
    });
  });

  it.each([
    [
      "minimax-m2.7",
      "high",
      "anthropic-messages",
      {
        thinking: { type: "enabled", budget_tokens: 8192 },
        output_config: { effort: "high" },
      },
    ],
    ["kimi-k3", "off", "openai-completions", { reasoning_effort: "max" }],
  ] as const)("strips unsupported %s reasoning controls", async (model, level, api, controls) => {
    expect(await captureGoWirePayload(level, { model, ...controls }, api)).toEqual({ model });
  });

  it.each([OPENAI_URL, "https://proxy.example.test/v1", undefined])(
    "retains Kimi policy when URL %s needs no patch",
    (baseUrl) => {
      const model = makeRuntimeModel("kimi-k2.7-code", { baseUrl });
      expect(normalizeModel(model)).toEqual({ ...model, ...NO_REASONING });
      const unchanged = makeRuntimeModel("synthetic-model", { baseUrl });
      expect(normalizeModel(unchanged)).toBeUndefined();
    },
  );

  it("projects URL transport patches without leaking model context", () => {
    const model = makeRuntimeModel("synthetic-model", {
      headers: { "x-synthetic": "retained" },
    });
    expect(provider.normalizeTransport?.({ ...model, config: {} })).toEqual({
      api: "openai-completions",
      baseUrl: OPENAI_URL,
    });
    expect(model.baseUrl).toBe(LEGACY_URL);
  });

  it("canonicalizes stale OpenCode Go base URLs", async () => {
    const normalizeTransport = (api: string, baseUrl: string) =>
      provider.normalizeTransport?.({ provider: "opencode-go", api, baseUrl } as never);
    expect(
      provider.normalizeConfig?.({
        provider: "opencode-go",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://opencode.ai/go/v1/",
          models: [],
        },
      } as never),
    ).toMatchObject({ baseUrl: OPENAI_URL });
    expect(
      normalizeModel(makeRuntimeModel("kimi-k2.5", { baseUrl: "https://opencode.ai/go/v1" })),
    ).toMatchObject({ baseUrl: OPENAI_URL });
    expect(normalizeModel(makeRuntimeModel("kimi-k2.7-code"))).toMatchObject(NO_REASONING);
    expect(normalizeTransport("openai-completions", "https://opencode.ai/go/v1")).toEqual({
      api: "openai-completions",
      baseUrl: OPENAI_URL,
    });
    expect(normalizeTransport("anthropic-messages", "https://opencode.ai/go")).toEqual({
      api: "anthropic-messages",
      baseUrl: ANTHROPIC_URL,
    });
  });
});
