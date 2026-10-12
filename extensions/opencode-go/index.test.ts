import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { NON_ENV_SECRETREF_MARKER } from "openclaw/plugin-sdk/provider-auth-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildOpencodeGoLiveProviderConfig,
  buildStaticOpencodeGoProviderConfig,
  resolveOpencodeGoStarterModel,
} from "./provider-catalog.js";
import opencodeGoProviderDiscovery from "./provider-discovery.js";

const requireRecord = createRequireRecord("record", "expected-label-record");

function requireCatalogEntry(entries: readonly unknown[] | null | undefined, id: string) {
  if (!entries) {
    throw new Error("expected supplemental catalog entries");
  }
  const entry = entries.find((candidate) => requireRecord(candidate, "catalog entry").id === id);
  if (!entry) {
    throw new Error(`expected supplemental catalog entry ${id}`);
  }
  return requireRecord(entry, `supplemental catalog entry ${id}`);
}

const ACTIVE_MODEL_IDS = manifest.modelCatalog.providers["opencode-go"].models
  .filter((model) => !("status" in model))
  .map((model) => model.id);

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

async function captureGoWirePayload({
  thinkingLevel,
  payload,
  standalone = false,
  sourceApi = "openai-completions",
}: {
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"];
  payload: Record<string, unknown> & { model: string };
  standalone?: boolean;
  sourceApi?: "openai-completions" | "anthropic-messages";
}) {
  const provider = await registerSingleProviderPlugin(plugin);
  const modelId = payload.model;
  const model: Parameters<StreamFn>[0] = {
    id: modelId,
    name: modelId,
    provider: "opencode-go",
    api: standalone ? "openclaw-provider-simple:synthetic" : sourceApi,
    baseUrl:
      sourceApi === "anthropic-messages"
        ? "https://opencode.ai/zen/go"
        : "https://opencode.ai/zen/go/v1",
    reasoning: true,
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const baseStreamFn = vi.fn<StreamFn>((runtimeModel, _context, options) => {
    void options?.onPayload?.(payload, runtimeModel);
    return createAssistantMessageEventStream();
  });
  const wrap = standalone ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const streamFn = wrap?.({
    streamFn: baseStreamFn,
    provider: "opencode-go",
    modelId,
    model,
    sourceApi: standalone ? sourceApi : undefined,
    thinkingLevel,
  });
  expect(streamFn).toBeTypeOf("function");
  await streamFn?.(model, { messages: [] }, {});
  expect(baseStreamFn).toHaveBeenCalledOnce();
  return payload;
}

function createCatalogFetchGuard(params: {
  upstreamModels: Record<string, unknown>;
  liveModelIds: string[] | (() => string[]);
}) {
  return vi.fn(async ({ url }: { url: string; init?: RequestInit }) => ({
    response: new Response(
      JSON.stringify(
        url === "https://models.opencode.ai/api.json"
          ? {
              "opencode-go": {
                id: "opencode-go",
                api: "https://opencode.ai/zen/go/v1",
                npm: "@ai-sdk/openai-compatible",
                models: params.upstreamModels,
              },
            }
          : {
              data: (typeof params.liveModelIds === "function"
                ? params.liveModelIds()
                : params.liveModelIds
              ).map((id) => ({ id, object: "model" })),
            },
      ),
    ),
    finalUrl: url,
    release: vi.fn(async () => undefined),
  }));
}

describe("opencode-go provider plugin", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it.each(["deepseek-v4-pro", "deepseek-v4-flash", "kimi-k3"] as const)(
    "keeps %s thinking per invocation on one standalone completion wrapper",
    async (modelId) => {
      const provider = await registerSingleProviderPlugin(plugin);
      const catalog = buildStaticOpencodeGoProviderConfig();
      const entry = catalog.models.find((model) => model.id === modelId);
      if (!entry) {
        throw new Error(`Missing ${modelId} catalog entry`);
      }
      const model: Parameters<StreamFn>[0] = {
        ...entry,
        input: entry.input.filter((kind) => kind === "text" || kind === "image"),
        provider: "opencode-go",
        api: "openclaw-provider-simple:synthetic",
        baseUrl: catalog.baseUrl,
      };
      let payload: Record<string, unknown> | undefined;
      const baseStreamFn: StreamFn = async (runtimeModel, context, options) => {
        const request = buildOpenAICompletionsParams(
          { ...runtimeModel, api: "openai-completions" },
          context,
          options,
        );
        await options?.onPayload?.(request, runtimeModel);
        payload = request;
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
          {
            messages: [{ role: "user", content: "Synthetic request", timestamp: 1 }],
          },
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
    const provider = await registerSingleProviderPlugin(plugin);
    const supplemental = await provider.augmentModelCatalog?.({ entries: [] } as never);

    for (const modelId of ACTIVE_MODEL_IDS) {
      expect(provider.resolveDynamicModel?.({ modelId } as never)).toMatchObject({
        id: modelId,
        provider: "opencode-go",
      });
    }
    expect(requireCatalogEntry(supplemental, "hy3-preview").status).toBe("preview");
    expect(provider.resolveDynamicModel?.({ modelId: "kimi-k2.6" } as never)).toMatchObject({
      id: "kimi-k2.6",
      input: ["text", "image"],
    });
    expect(provider.resolveDynamicModel?.({ modelId: "qwen3.8-max" } as never)).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
      compat: { thinkingFormat: "qwen" },
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "opencode-go",
        modelId: "deepseek-v4-flash",
        api: "openai-completions",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "high", "max"] },
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }],
      defaultLevel: "high",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "opencode-go",
        modelId: "minimax-m2.7",
        api: "anthropic-messages",
        reasoning: true,
      }),
    ).toEqual({ levels: [{ id: "high", label: "always on" }], defaultLevel: "high" });
  });

  it("lists every advertised chat model, enriching ids with upstream metadata", async () => {
    const fetchGuard = createCatalogFetchGuard({
      upstreamModels: {
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
      liveModelIds: [
        "ox-alpha-free",
        "minimax-future",
        "legacy-model",
        "unknown-live-model",
        "future-embedding",
      ],
    });

    const result = await buildOpencodeGoLiveProviderConfig({
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });

    expect(result.models.map((model) => model.id)).toEqual([
      "ox-alpha-free",
      "minimax-future",
      "unknown-live-model",
    ]);
    expect(result.models[0]).toMatchObject({
      id: "ox-alpha-free",
      name: "Ox Alpha Free (Unlimited)",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      compat: { supportedReasoningEfforts: ["low", "high", "max"], supportsTools: true },
    });
    expect(result.models[1]).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
      cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
    });
    expect(result.models[2]).toMatchObject({
      provider: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      input: ["text"],
    });
    const listingRequest = fetchGuard.mock.calls.find(
      ([request]) => request.url === "https://opencode.ai/zen/go/v1/models",
    )?.[0];
    expect(new Headers(listingRequest?.init?.headers).get("user-agent")).toMatch(/^openclaw\//);

    const provider = await registerSingleProviderPlugin(plugin);
    expect(provider.resolveDynamicModel?.({ modelId: "legacy-model" } as never)).toBeUndefined();
    const supplemental = await provider.augmentModelCatalog?.({ entries: [] } as never);
    expect(requireCatalogEntry(supplemental, "legacy-model").status).toBe("deprecated");
    expect(requireCatalogEntry(supplemental, "hy3-preview").status).toBe("preview");
  });

  it("never resolves another account's upstream-only Go model outside its authenticated catalog", async () => {
    const upstreamModels = {
      "account-a-only": upstreamModel("account-a-only"),
      "account-b-only": upstreamModel("account-b-only"),
    };
    const accountAFetchGuard = createCatalogFetchGuard({
      upstreamModels,
      liveModelIds: ["account-a-only"],
    });
    const accountA = await buildOpencodeGoLiveProviderConfig({
      discoveryApiKey: "account-a-key",
      fetchGuard: accountAFetchGuard,
    });
    expect(accountA.models.map((model) => model.id)).toEqual(["account-a-only"]);

    const accountBFetchGuard = createCatalogFetchGuard({
      upstreamModels,
      liveModelIds: ["account-b-only"],
    });
    const accountB = await buildOpencodeGoLiveProviderConfig({
      discoveryApiKey: "account-b-key",
      fetchGuard: accountBFetchGuard,
    });
    expect(accountB.models.map((model) => model.id)).toEqual(["account-b-only"]);

    const provider = await registerSingleProviderPlugin(plugin);
    expect(provider.resolveDynamicModel?.({ modelId: "account-a-only" } as never)).toBeUndefined();
    expect(provider.resolveDynamicModel?.({ modelId: "account-b-only" } as never)).toBeUndefined();
    expect(provider.prepareDynamicModel).toBeUndefined();
  });

  it("evicts withdrawn or unsafe upstream models while retaining trusted offline seeds", async () => {
    const originalFetchGuard = createCatalogFetchGuard({
      upstreamModels: {
        "withdrawn-model": upstreamModel("withdrawn-model"),
      },
      liveModelIds: ["withdrawn-model"],
    });
    await expect(
      buildOpencodeGoLiveProviderConfig({
        discoveryApiKey: "resolved-opencode-key",
        fetchGuard: originalFetchGuard,
      }),
    ).resolves.toMatchObject({ models: [expect.objectContaining({ id: "withdrawn-model" })] });

    clearLiveCatalogCacheForTests();
    const refreshedFetchGuard = createCatalogFetchGuard({
      upstreamModels: {
        "replacement-model": upstreamModel("replacement-model"),
        "unsafe-model": upstreamModel("unsafe-model", {
          provider: { api: "https://attacker.invalid/v1" },
        }),
      },
      liveModelIds: ["replacement-model", "unsafe-model"],
    });
    // Rejected metadata cannot redirect inference; the listed id keeps Go's own route.
    await expect(
      buildOpencodeGoLiveProviderConfig({
        discoveryApiKey: "resolved-opencode-key",
        fetchGuard: refreshedFetchGuard,
      }),
    ).resolves.toMatchObject({
      models: [
        expect.objectContaining({ id: "replacement-model" }),
        expect.objectContaining({ id: "unsafe-model", baseUrl: "https://opencode.ai/zen/go/v1" }),
      ],
    });

    const provider = await registerSingleProviderPlugin(plugin);
    const entries = await provider.augmentModelCatalog?.({ entries: [] } as never);
    expect(entries?.some((entry) => entry.id === "withdrawn-model")).toBe(false);
    expect(entries?.some((entry) => entry.id === "unsafe-model")).toBe(false);
    expect(requireCatalogEntry(entries, "hy3-preview").status).toBe("preview");
  });

  it("exposes only trusted offline starter models through provider discovery", async () => {
    expect(manifest.providerCatalogEntry).toBe("./provider-discovery.ts");
    expect(manifest.modelCatalog.discovery["opencode-go"]).toBe("runtime");
    const result = await opencodeGoProviderDiscovery.staticCatalog?.run({} as never);
    if (!result || !("provider" in result)) {
      throw new Error("expected OpenCode Go static provider");
    }
    const deepSeekPro = result.provider.models.find((model) => model.id === "deepseek-v4-pro");
    const deepSeekFlash = result.provider.models.find((model) => model.id === "deepseek-v4-flash");
    const modelIds = result.provider.models.map((model) => model.id);
    expect(new Set(modelIds).size).toBe(modelIds.length);
    expect(modelIds.toSorted()).toEqual(ACTIVE_MODEL_IDS.toSorted());
    expect(deepSeekPro).toMatchObject({
      provider: "opencode-go",
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: { supportedReasoningEfforts: ["high", "max"] },
    });
    expect(deepSeekFlash).toMatchObject({
      provider: "opencode-go",
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: { supportedReasoningEfforts: ["low", "high", "max"] },
    });
    expect(modelIds).not.toContain("hy3-preview");
  });

  it("skips unrelated scoped discovery even when OpenCode credentials are configured", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const resolveProviderApiKey = vi.fn(() => ({
      apiKey: "configured-opencode-key",
      discoveryApiKey: "configured-opencode-key",
    }));

    try {
      await expect(
        provider.catalog?.run({
          config: {},
          env: {},
          providerIds: ["anthropic"],
          resolveProviderApiKey,
        } as never),
      ).resolves.toBeNull();
      expect(resolveProviderApiKey).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      await expect(
        provider.catalog?.run({
          config: {},
          env: {},
          providerIds: ["opencode-go"],
          resolveProviderApiKey: () => ({ apiKey: "configured-opencode-key" }),
        } as never),
      ).resolves.toMatchObject({
        provider: { apiKey: "configured-opencode-key" },
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("never fetches either catalog when no shared OpenCode key is configured", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    try {
      await expect(
        provider.catalog?.run({
          config: {},
          env: {},
          resolveProviderApiKey: () => ({ apiKey: undefined }),
          resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
        } as never),
      ).resolves.toBeNull();
      await expect(buildOpencodeGoLiveProviderConfig()).resolves.toMatchObject({
        models: expect.arrayContaining([expect.objectContaining({ id: "deepseek-v4-pro" })]),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not select an unavailable preferred onboarding model", async () => {
    const modelIds = ["glm-5.1"];
    const fetchGuard = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({ data: modelIds.map((id) => ({ id, object: "model" })) }),
      ),
      finalUrl: "https://opencode.ai/zen/go/v1/models",
      release: vi.fn(async () => undefined),
    }));

    await expect(
      resolveOpencodeGoStarterModel({
        apiKey: "resolved-opencode-key",
        preferredModelRef: "opencode-go/deepseek-v4-pro",
        fetchGuard,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not mix provider-specific runtime auth with shared discovery auth", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("blocked fetch"));
    const resolveProviderApiKey = vi.fn((providerId: string) =>
      providerId === "opencode-go"
        ? { apiKey: NON_ENV_SECRETREF_MARKER, discoveryApiKey: undefined }
        : { apiKey: "shared-opencode-key", discoveryApiKey: "shared-opencode-key" },
    );

    try {
      const result = await provider.catalog?.run({
        config: {},
        env: {},
        resolveProviderApiKey,
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      } as never);

      if (!result || !("provider" in result)) {
        throw new Error("expected OpenCode Go provider result");
      }
      expect(result.provider.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
      expect(result.provider.models.map((model) => model.id)).toContain("deepseek-v4-pro");
      expect(resolveProviderApiKey).toHaveBeenCalledExactlyOnceWith("opencode-go");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not synthesize a stream when the runtime provides none", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.wrapStreamFn?.({ streamFn: undefined } as never)).toBeUndefined();
  });

  it("attaches a stable conversation id only to native OpenCode Go requests", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const resolveTurnState = provider.resolveTransportTurnState;

    expect(
      resolveTurnState?.({
        provider: "opencode-go",
        modelId: "glm-5",
        model: {
          provider: "opencode-go",
          id: "glm-5",
          api: "openai-completions",
          baseUrl: "https://opencode.ai/zen/go/v1",
        },
        sessionId: "conversation-123",
        turnId: "turn-1",
        attempt: 1,
        transport: "stream",
      } as never),
    ).toEqual({ headers: { "x-opencode-session": "conversation-123" } });
    expect(
      resolveTurnState?.({
        provider: "opencode-go",
        modelId: "glm-5",
        model: {
          provider: "opencode-go",
          id: "glm-5",
          api: "openai-completions",
          baseUrl: "https://opencode.ai/zen/go/v1",
          headers: { "X-OpenCode-Session": "configured-session" },
        },
        turnId: "turn-1",
        attempt: 1,
        transport: "stream",
      } as never),
    ).toBeUndefined();
    expect(
      resolveTurnState?.({
        provider: "opencode-go",
        modelId: "glm-5",
        model: {
          provider: "opencode-go",
          id: "glm-5",
          api: "openai-completions",
          baseUrl: "https://proxy.example.com/v1",
        },
        sessionId: "conversation-123",
        turnId: "turn-1",
        attempt: 1,
        transport: "stream",
      } as never),
    ).toBeUndefined();
  });

  it("identifies native Anthropic stream and simple requests without tagging proxies", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    for (const testCase of [
      {
        wrap: provider.wrapStreamFn,
        runtimeApi: "anthropic-messages",
        sourceApi: undefined,
      },
      {
        wrap: provider.wrapSimpleCompletionStreamFn,
        runtimeApi: "openclaw-provider-simple:opencode-go:qwen3.8-max",
        sourceApi: "anthropic-messages",
      },
    ] as const) {
      const capturedHeaders: Array<Record<string, string> | undefined> = [];
      const baseStreamFn = (_model: unknown, _context: unknown, options: unknown) => {
        capturedHeaders.push((options as { headers?: Record<string, string> })?.headers);
        return {} as never;
      };
      const streamFn = testCase.wrap?.({
        streamFn: baseStreamFn as never,
        providerId: "opencode-go",
        modelId: "qwen3.8-max",
        thinkingLevel: "high",
        sourceApi: testCase.sourceApi,
      } as never);

      expect(streamFn).toBeTypeOf("function");
      await streamFn?.(
        {
          provider: "opencode-go",
          id: "qwen3.8-max",
          api: testCase.runtimeApi,
          baseUrl: "https://opencode.ai/zen/go",
        } as never,
        {} as never,
        { headers: { "User-Agent": "configured-client/1.0", "X-Custom": "1" } },
      );
      await streamFn?.(
        {
          provider: "opencode-go",
          id: "qwen3.8-max",
          api: testCase.runtimeApi,
          baseUrl: "https://proxy.example.com",
        } as never,
        {} as never,
        { headers: { "User-Agent": "configured-client/2.0", "X-Custom": "2" } },
      );

      expect(capturedHeaders).toEqual([
        {
          "User-Agent": expect.stringMatching(/^openclaw\//),
          "X-Custom": "1",
        },
        { "User-Agent": "configured-client/2.0", "X-Custom": "2" },
      ]);
    }
  });

  it.each([
    ["deepseek-v4-flash", "low", "low"],
    ["deepseek-v4-flash", "high", "high"],
    ["deepseek-v4-flash", "max", "max"],
  ] as const)(
    "maps OpenCode Go %s thinking %s to %s reasoning effort",
    async (modelId, thinkingLevel, reasoningEffort) => {
      const payload = await captureGoWirePayload({
        thinkingLevel,
        payload: {
          model: modelId,
        },
      });

      expect(payload).toEqual({
        model: modelId,
        thinking: { type: "enabled" },
        reasoning_effort: reasoningEffort,
      });
    },
  );

  it("strips unsupported Kimi reasoning on Go", async () => {
    const payload = await captureGoWirePayload({
      thinkingLevel: "high",
      payload: {
        model: "kimi-k2.6",
        reasoning_effort: "high",
        reasoning: { effort: "high" },
        reasoningEffort: "high",
        messages: [{ role: "assistant", content: "done", reasoning_content: "earlier reasoning" }],
        input: [
          { type: "reasoning", summary: [] },
          { role: "assistant", content: "done", reasoning_details: [] },
        ],
      },
    });

    expect(payload).toEqual({
      model: "kimi-k2.6",
      messages: [{ role: "assistant", content: "done" }],
      input: [{ role: "assistant", content: "done" }],
    });
  });

  it("keeps fixed reasoning for minimax-m2.7 on the Go wire", async () => {
    const modelId = "minimax-m2.7";
    const payload = await captureGoWirePayload({
      thinkingLevel: "high",
      sourceApi: "anthropic-messages",
      payload: {
        model: modelId,
        thinking: { type: "enabled", budget_tokens: 8192 },
        output_config: { effort: "high" },
      },
    });
    expect(payload).toEqual({ model: modelId });
  });

  it("keeps Kimi K3 reasoning off exact", async () => {
    const thinkingLevel = "off";
    const payload = await captureGoWirePayload({
      thinkingLevel,
      payload: {
        model: "kimi-k3",
        reasoning_effort: "max",
      },
    });
    expect(payload).toEqual({ model: "kimi-k3" });
  });

  it("canonicalizes stale OpenCode Go base URLs", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const normalizedConfig = requireRecord(
      provider.normalizeConfig?.({
        provider: "opencode-go",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://opencode.ai/go/v1/",
          models: [],
        },
      } as never),
      "normalized config",
    );
    expect(normalizedConfig.baseUrl).toBe("https://opencode.ai/zen/go/v1");

    const normalizedModel = requireRecord(
      provider.normalizeResolvedModel?.({
        provider: "opencode-go",
        model: {
          provider: "opencode-go",
          id: "kimi-k2.5",
          name: "Kimi K2.5",
          api: "openai-completions",
          baseUrl: "https://opencode.ai/go/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262_144,
          maxTokens: 65_536,
        },
      } as never),
      "normalized model",
    );
    expect(normalizedModel.baseUrl).toBe("https://opencode.ai/zen/go/v1");

    const normalizedKimi = requireRecord(
      provider.normalizeResolvedModel?.({
        provider: "opencode-go",
        model: {
          provider: "opencode-go",
          id: "kimi-k2.7-code",
          name: "Kimi K2.7 Code",
          api: "openai-completions",
          baseUrl: "https://opencode.ai/zen/go/v1",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262_144,
          maxTokens: 262_144,
        },
      } as never),
      "normalized Kimi model",
    );
    expect(normalizedKimi.reasoning).toBe(false);
    expect(requireRecord(normalizedKimi.compat, "normalized Kimi compat")).toMatchObject({
      supportsReasoningEffort: false,
    });

    expect(
      provider.normalizeTransport?.({
        provider: "opencode-go",
        api: "openai-completions",
        baseUrl: "https://opencode.ai/go/v1",
      } as never),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });

    expect(
      provider.normalizeTransport?.({
        provider: "opencode-go",
        api: "anthropic-messages",
        baseUrl: "https://opencode.ai/go",
      } as never),
    ).toEqual({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
    });
  });
});
