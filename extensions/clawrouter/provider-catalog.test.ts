import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import {
  buildClawRouterProviderConfig as loadCatalog,
  normalizeClawRouterResolvedModel as resolveModel,
} from "./provider-catalog.js";

const PRICING = {
  inputMicrosPerMillion: 3_000_000,
  outputMicrosPerMillion: 15_000_000,
  cachedInputMicrosPerMillion: 300_000,
  cacheWrite5mInputMicrosPerMillion: 3_750_000,
  maxInputTokens: 1_000_000,
  defaultMaxOutputTokens: 64_000,
};

function catalogRow(
  id: string,
  displayName: string,
  upstream: string,
  capabilities: string[],
  routes: Array<[string, string]> = [],
  model: Record<string, unknown> = {},
) {
  return {
    id,
    displayName,
    openaiCompatible: id === "openai" || id === "deepseek",
    nativeBaseUrl: `/v1/native/${id}`,
    routes: routes.map(([path, requestFormat]) => ({ path, requestFormat, methods: ["POST"] })),
    models: [{ id: `${id}/${upstream}`, upstream, capabilities, ...model }],
  };
}

const CATALOG = {
  providers: [
    catalogRow("openai", "OpenAI", "gpt-6.1-sol", ["llm.responses", "llm.chat"], [], {
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      pricing: PRICING,
    }),
    catalogRow("deepseek", "DeepSeek", "deepseek-v4-flash", ["llm.chat"]),
    catalogRow(
      "anthropic",
      "Anthropic",
      "claude-opus-5-5",
      ["llm.messages"],
      [["/v1/messages", "anthropic.messages"]],
      { pricing: PRICING },
    ),
    catalogRow(
      "google-gemini",
      "Google Gemini",
      "gemini-3.5-flash",
      ["llm.stream"],
      [["/v1beta/models/${model}:streamGenerateContent", "google.generate_content"]],
      { id: "google/gemini-3.5-flash" },
    ),
    catalogRow("cohere", "Cohere", "command-a-plus-05-2026", ["llm.chat"]),
  ],
};
function buildFetchGuard(providers?: unknown[]) {
  return vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async () => ({
    response: Response.json(providers ? { providers } : CATALOG),
    finalUrl: "https://clawrouter.example/v1/catalog",
    release: async () => undefined,
  }));
}

beforeEach(() => clearLiveCatalogCacheForTests());
afterEach(() => vi.restoreAllMocks());

describe("ClawRouter provider catalog", () => {
  it("maps every supported catalog protocol to its OpenClaw transport", async () => {
    buildFetchGuard();
    const provider = await loadCatalog({
      apiKey: "clawrouter-test-key",
      baseUrl: "https://clawrouter.example/v1",
    });

    const openai = provider.models.find((model) => model.id === "openai/gpt-6.1-sol");
    expect(openai).toMatchObject({
      name: "OpenAI · gpt-6.1-sol",
      family: "openai",
      api: "openai-responses",
      baseUrl: "https://clawrouter.example/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    });
    expect(openai?.thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
    expect(openai?.compat).toEqual({
      codeMode: "preferred",
      supportsTemperature: false,
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    });
    const deepseek = provider.models.find((model) => model.id === "deepseek/deepseek-v4-flash");
    expect(deepseek).toMatchObject({
      api: "openai-completions",
    });
    expect(deepseek?.thinkingLevelMap).toBeUndefined();
    expect(provider.models.find((model) => model.id === "anthropic/claude-opus-5-5")).toMatchObject(
      {
        family: "anthropic",
        compat: { codeMode: "preferred" },
        mediaInput: { image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" } },
        api: "anthropic-messages",
        baseUrl: "https://clawrouter.example/v1/native/anthropic",
      },
    );
    expect(provider.models.find((model) => model.id === "google/gemini-3.5-flash")).toMatchObject({
      family: "google",
      api: "google-generative-ai",
      baseUrl: "https://clawrouter.example/v1/native/google-gemini/v1beta",
    });
  });

  it.each([
    [["image"], ["image"]],
    ["image", ["text"]],
    [[], ["text"]],
  ])(
    "preserves image-only input and fails malformed declarations closed: %j",
    async (input, expected) => {
      buildFetchGuard([
        catalogRow("openai", "OpenAI", "gpt-6.1-sol", ["llm.responses"], [], { input }),
      ]);
      const { models } = await loadCatalog({ apiKey: "fixture-key" });
      expect(models[0]?.input).toEqual(expected);
    },
  );

  it("validates catalog prices and limits while retaining the first supported duplicate", async () => {
    buildFetchGuard([
      null,
      {
        ...catalogRow("invalid", "Invalid", "model", ["llm.chat"]),
        nativeBaseUrl: "/wrong",
      },
      {
        ...catalogRow("openai", "OpenAI", "model", ["llm.responses"]),
        models: [
          null,
          { id: "missing-upstream", capabilities: ["llm.responses"] },
          { id: "duplicate", upstream: "model", capabilities: ["audio.speech"] },
          {
            id: "duplicate",
            upstream: "model",
            displayName: "First",
            capabilities: ["llm.responses"],
            pricing: {
              inputMicrosPerMillion: -1,
              outputMicrosPerMillion: "3000000",
              cachedInputMicrosPerMillion: 0,
              cacheWrite5mInputMicrosPerMillion: -1,
              cacheWrite1hInputMicrosPerMillion: 2_000_000,
              maxInputTokens: 1.5,
              defaultMaxOutputTokens: 0,
              serviceTiers: [{ id: " priority " }, null, { id: "priority" }, { id: "default" }],
            },
          },
          {
            id: "duplicate",
            upstream: "model",
            displayName: "Later",
            capabilities: ["llm.responses"],
          },
          { id: "defaults", upstream: "model", capabilities: ["llm.chat"], pricing: null },
        ],
      },
    ]);

    const provider = await loadCatalog({ apiKey: "fixture-key" });

    expect(provider.models.map((model) => model.id)).toEqual(["defaults", "duplicate"]);
    expect(provider.models[1]).toMatchObject({
      name: "First",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 2 },
      contextWindow: 200_000,
      maxTokens: 32_768,
      params: { clawrouterRoute: { serviceTiers: ["priority", "priority", "default"] } },
    });
    expect(provider.models[0]).toMatchObject({
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_768,
    });
    expect(provider.models[0]?.params?.clawrouterRoute).not.toHaveProperty("serviceTiers");
  });

  it("reuses granted models for an hour without mixing credentials or endpoints", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const fetchGuard = buildFetchGuard();
    const params = {
      apiKey: "catalog-key-a",
      baseUrl: "https://clawrouter.example",
    };
    const first = await loadCatalog(params);
    now.mockReturnValue(1_800_000_000_000 + 59 * 60_000);
    expect(await loadCatalog(params)).toEqual(first);
    expect(fetchGuard).toHaveBeenCalledOnce();

    await loadCatalog({ ...params, discoveryApiKey: "catalog-key-b" });
    await loadCatalog({ ...params, baseUrl: "https://other.example" });
    expect(fetchGuard).toHaveBeenCalledTimes(3);
    const headers = fetchGuard.mock.calls[1]?.[0].init?.headers;
    expect(new Headers(headers).get("authorization")).toBe("Bearer catalog-key-b");

    // A cache hit does not renew the original deadline indefinitely.
    now.mockReturnValue(1_800_000_000_000 + 60 * 60_000);
    await loadCatalog(params);
    expect(fetchGuard).toHaveBeenCalledTimes(4);
  });
});

const auth = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "fixture-key" })),
}));
// mock-isolation: Native model resolution must not read real credential stores.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => auth);

async function capture(dispatch: () => ReturnType<StreamFn>) {
  let body: Record<string, unknown> | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    body = (await new Request(input, init).json()) as Record<string, unknown>;
    return Response.json(
      { error: { type: "invalid_request_error", message: "fixture" } },
      { status: 400 },
    );
  });
  await (await dispatch()).result();
  if (!body) {
    throw new Error("transport did not send a request body");
  }
  return body;
}
async function routedStream(id: string) {
  clearLiveCatalogCacheForTests();
  const upstream = id.slice(id.indexOf("/") + 1);
  const anthropic = id.startsWith("anthropic/");
  buildFetchGuard([
    catalogRow(
      anthropic ? "anthropic" : "openai",
      "Fixture",
      upstream,
      [anthropic ? "llm.messages" : "llm.responses"],
      anthropic ? [["/v1/messages", "anthropic.messages"]] : [],
    ),
  ]);
  const { models } = await loadCatalog({
    apiKey: "fixture-key",
    baseUrl: "https://clawrouter.example",
  });
  const model = resolveModel({
    ...models[0],
    provider: "clawrouter",
  } as ProviderRuntimeModel) as Model;
  const registered = await registerSingleProviderPlugin(plugin);
  const wrapped = registered.wrapStreamFn!({
    provider: "clawrouter",
    modelId: model.id,
    streamFn: streamSimple,
  })!;
  return { model, wrapped };
}
it("does not inherit native facts from unknown identities, wire APIs or unqualified providers", async () => {
  const cases = [
    ["openai", "gpt-6-unknown", "responses"],
    ["openai", "GPT-6.1-SOL", "responses"],
    ["openai", "gpt-6-astra", "chat"],
    ["anthropic", "claude-opus-6", "messages"],
    ["deepseek", "deepseek-v4-flash", "chat"],
    ["deepseek", "gpt-6.1-sol", "chat"],
    ["acme", "claude-opus-5-5", "messages"],
  ] as const;
  buildFetchGuard(
    cases.map(([id, upstream, api]) =>
      catalogRow(
        id,
        id,
        upstream,
        ["llm." + api],
        api === "messages" ? [["/v1/messages", "anthropic.messages"]] : [],
      ),
    ),
  );
  const { models } = await loadCatalog({ apiKey: "fixture-key" });
  expect(models).toHaveLength(cases.length);
  for (const model of models) {
    expect([model.compat, model.mediaInput], model.id).toEqual([undefined, undefined]);
    if (model.id === "openai/gpt-6-unknown" || model.id === "deepseek/gpt-6.1-sol") {
      expect(model.input).toEqual(["text"]);
    }
    if (model.id !== "deepseek/deepseek-v4-flash") {
      expect(model.family).toBeUndefined();
    }
  }
});
it("resolves native image limits through the registered model hook", async () => {
  const registered = await registerSingleProviderPlugin(plugin);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      providers: ["claude-opus-5-5", "claude-haiku-4-5"].map((id) =>
        catalogRow(
          "anthropic",
          "Anthropic",
          id,
          ["llm.messages"],
          [["/v1/messages", "anthropic.messages"]],
        ),
      ),
    }),
  );
  for (const [upstream, codeMode, side] of [
    ["claude-opus-5-5", "preferred", 2576],
    ["claude-haiku-4-5", "capable", 1568],
  ] as const) {
    const model = await registered.prepareDynamicModel?.({
      config: { models: {} },
      provider: "clawrouter",
      modelId: "anthropic/" + upstream,
      modelRegistry: { find: () => null },
    } as never);
    if (!model) {
      throw new Error("ClawRouter dynamic model missing");
    }
    expect(model?.compat).toEqual({ codeMode });
    expect(model?.mediaInput).toEqual({
      image: { maxSidePx: side, preferredSidePx: side, tokenMode: "provider" },
    });
  }
});
it("omits temperature only for qualified routed OpenAI models", async () => {
  for (const upstream of ["gpt-6.1-sol", "gpt-6-unknown"]) {
    const { model, wrapped } = await routedStream("openai/" + upstream);
    const body = await capture(() =>
      wrapped(
        model,
        { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
        { apiKey: "fixture-key", temperature: 0.2, maxTokens: 64 },
      ),
    );
    expect(body.model).toBe("openai/" + upstream);
    if (upstream === "gpt-6.1-sol") {
      expect(body).not.toHaveProperty("temperature");
    } else {
      expect(body.temperature).toBe(0.2);
    }
  }
});
it("strips routed Claude prefill only with thinking enabled", async () => {
  const { model, wrapped } = await routedStream("anthropic/claude-opus-4-8");
  const context: Context = {
    messages: [
      { role: "user", content: "Name a color.", timestamp: 0 },
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "The color is" }],
        api: "anthropic-messages",
        provider: "clawrouter",
        model: model.id,
        timestamp: 1,
      }),
    ],
  };
  for (const reasoning of ["high", undefined] as const) {
    const body = await capture(() =>
      wrapped(model, context, {
        apiKey: "fixture-key",
        maxTokens: 2048,
        ...(reasoning ? { reasoning } : {}),
      }),
    );
    expect(body.model).toBe("claude-opus-4-8");
    expect((body.messages as Array<{ role: string }>).map(({ role }) => role)).toEqual(
      reasoning ? ["user"] : ["user", "assistant"],
    );
    if (reasoning) {
      expect((body.thinking as { type?: unknown })?.type).toMatch(/^(?:adaptive|enabled)$/u);
    } else {
      expect(body.thinking).toEqual({ type: "disabled" });
    }
  }
});
