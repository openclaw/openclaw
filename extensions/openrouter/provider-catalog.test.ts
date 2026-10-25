import assert from "node:assert/strict";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import openrouterPlugin from "./index.js";
import { buildOpenrouterLiveProvider } from "./provider-catalog.js";

const provider = await registerSingleProviderPlugin(openrouterPlugin);
afterEach(() => vi.restoreAllMocks());

function catalogFetch(data: unknown[], release = vi.fn(async () => undefined)) {
  return vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async ({ url }) => ({
    response: Response.json({ data }),
    finalUrl: url,
    release,
  }));
}
function textRow(id: string, modality = "text->text", fields: Record<string, unknown> = {}) {
  return { id, architecture: { modality }, ...fields };
}
type Catalog = Awaited<ReturnType<typeof buildOpenrouterLiveProvider>>;
function catalogModel(catalog: Catalog, id: string) {
  const model = catalog.models.find((entry) => entry.id === id);
  assert(model, `Missing discovered model: ${id}`);
  return model;
}
function requestModel(catalog: Catalog, id: string, standalone = false) {
  const row = catalogModel(catalog, id);
  return {
    ...row,
    input: row.input.filter((kind) => kind === "text" || kind === "image"),
    provider: "openrouter",
    api: standalone ? "openclaw-provider-simple:fixture" : "openai-completions",
    baseUrl: catalog.baseUrl,
  };
}
async function reasoningCatalog(id: string, reasoning: Record<string, unknown>) {
  catalogFetch([
    {
      id,
      architecture: { modality: "text->text" },
      supported_parameters: ["reasoning", "tools"],
      reasoning,
    },
  ]);
  return buildOpenrouterLiveProvider({});
}
function thinkingProfile(catalog: Catalog, id: string) {
  const model = catalogModel(catalog, id);
  return provider.resolveThinkingProfile?.({
    ...model,
    provider: "openrouter",
    modelId: id,
    api: model.api ?? catalog.api,
  });
}
const userContext = {
  messages: [{ role: "user" as const, content: "Synthetic request", timestamp: 1 }],
};
async function reasoningPayload(
  catalog: Catalog,
  id: string,
  selected?: "off" | "low",
  standalone?: boolean,
  withBudget = false,
) {
  const model = requestModel(catalog, id, standalone);
  let payload: unknown;
  const streamFn: StreamFn = async (runtimeModel, context, options) => {
    const request = buildOpenAICompletionsParams(
      { ...runtimeModel, api: "openai-completions" },
      context,
      options,
    );
    if (withBudget) {
      request.reasoning = { max_tokens: 1024, exclude: true };
    }
    payload = (await options?.onPayload?.(request, runtimeModel)) ?? request;
    return createAssistantMessageEventStream();
  };
  const wrap = standalone ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  await wrap?.({
    provider: "openrouter",
    modelId: id,
    model: standalone === undefined ? undefined : model,
    sourceApi: standalone ? "openai-completions" : undefined,
    thinkingLevel: selected,
    streamFn,
  })?.(model, userContext, { reasoning: selected });
  return payload;
}
const privateBaseUrl = "https://private.example.invalid/v1";
function privateCatalog(overrides: Parameters<typeof buildOpenrouterLiveProvider>[0] = {}) {
  return buildOpenrouterLiveProvider({
    apiKey: "synthetic-private-key",
    baseUrl: privateBaseUrl,
    ...overrides,
  });
}
const requestHeaders = (fetchGuard: ReturnType<typeof catalogFetch>, index = 0) =>
  new Headers(fetchGuard.mock.calls[index]?.[0].init?.headers);

beforeEach(clearLiveCatalogCacheForTests);

it("discovers text capabilities and pricing, excluding non-text outputs", async () => {
  const release = vi.fn(async () => undefined);
  const fetchGuard = catalogFetch(
    [
      textRow("acme/priced", "text+image->text", {
        name: "Priced",
        supported_parameters: ["reasoning", "tools"],
        top_provider: { context_length: 1_048_576, max_completion_tokens: 65_536 },
        pricing: { prompt: "0.0000015", completion: "0.0000075" },
      }),
      {
        id: "acme/explicit",
        architecture: {
          input_modalities: ["text", "image", "audio", "video"],
          output_modalities: ["text"],
        },
      },
      textRow("acme/reasoning", "text->text", {
        supported_parameters: ["include_reasoning"],
        context_length: 32_000,
        max_completion_tokens: 4096,
      }),
      textRow("acme/image", "text+image->image"),
      { id: "acme/legacy" },
    ],
    release,
  );
  const catalog = await buildOpenrouterLiveProvider({
    apiKey: "OPENROUTER_API_KEY",
    discoveryApiKey: "resolved-openrouter-key",
  });
  expect(catalog.apiKey).toBe("OPENROUTER_API_KEY");
  expect(catalog.models.map(({ id }) => id)).not.toContain("acme/image");
  expect(catalogModel(catalog, "acme/priced")).toMatchObject({
    name: "Priced",
    reasoning: true,
    input: ["text", "image"],
    compat: { supportsTools: true },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    cost: { input: 1.5, output: 7.5 },
  });
  expect(catalogModel(catalog, "acme/explicit").input).toEqual(["text", "image"]);
  expect(catalogModel(catalog, "acme/reasoning")).toMatchObject({
    reasoning: true,
    compat: { supportsTools: false },
    contextWindow: 32_000,
    maxTokens: 4096,
  });
  expect(catalogModel(catalog, "acme/legacy").compat).toBeUndefined();
  expect(requestHeaders(fetchGuard).get("authorization")).toBe("Bearer resolved-openrouter-key");
  expect(release).toHaveBeenCalledOnce();
});

it("carries discovered Grok reasoning into profiles and requests", async () => {
  const id = "x-ai/grok-4.6";
  const efforts = ["high", "low"];
  const catalog = await reasoningCatalog(id, { supported_efforts: efforts, mandatory: true });
  const profile = thinkingProfile(catalog, id);
  expect(profile?.levels.map((level) => level.id).toSorted()).toEqual(["high", "low"]);
  expect(await reasoningPayload(catalog, id, "low")).toMatchObject({
    reasoning: { effort: "low" },
  });
});

it.each([true, false])("projects binary reasoning profiles (mandatory=%s)", async (mandatory) => {
  const id = "acme/binary";
  const catalog = await reasoningCatalog(id, {
    mandatory,
    supported_efforts: [],
    supports_max_tokens: true,
  });
  const row = catalogModel(catalog, id);
  expect(row.compat).toMatchObject({
    supportsReasoningEffort: false,
    supportedReasoningEfforts: [],
  });
  expect(row.thinkingLevelMap?.off).toBe(mandatory ? null : undefined);
  const profile = thinkingProfile(catalog, id);
  expect(profile?.levels).toEqual(
    mandatory ? [{ id: "low", label: "always on" }] : [{ id: "off" }, { id: "low", label: "on" }],
  );
});

it.each([
  [true, "off", false, false, undefined],
  [false, "off", true, false, { enabled: false }],
  [false, "low", false, false, { enabled: true }],
  [false, undefined, true, false, undefined],
  [true, undefined, false, true, { max_tokens: 1024, exclude: true }],
] as const)(
  "serializes binary reasoning: mandatory=%j, selected=%j",
  async (mandatory, selected, standalone, budget, expected) => {
    const id = "acme/binary";
    const catalog = await reasoningCatalog(id, {
      mandatory,
      supported_efforts: [],
      supports_max_tokens: true,
    });
    const payload = await reasoningPayload(catalog, id, selected, standalone, budget);
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("reasoning.effort");
    if (mandatory && selected === "off") {
      expect(payload).not.toHaveProperty("reasoning.enabled", false);
    } else if (expected === undefined) {
      expect(payload).not.toHaveProperty("reasoning");
    } else {
      expect(payload).toHaveProperty("reasoning", expected);
    }
  },
);

it("keeps catalog credentials and headers on the configured origin", async () => {
  const fetchGuard = catalogFetch([{ id: "custom/private-model" }]);
  const catalog = await buildOpenrouterLiveProvider({
    apiKey: "OPENROUTER_API_KEY",
    discoveryApiKey: "synthetic-private-proxy-key",
    baseUrl: "https://private.example.invalid/router/v1///",
    request: { headers: { "X-Private-Proxy-Tenant": "synthetic-tenant" } },
  });
  const request = fetchGuard.mock.calls[0]?.[0];
  expect(request?.url).toBe("https://private.example.invalid/router/v1/models");
  expect(catalog.baseUrl).toBe("https://private.example.invalid/router/v1");
  const headers = new Headers(request?.init?.headers);
  expect(headers.get("authorization")).toBe("Bearer synthetic-private-proxy-key");
  expect(headers.get("x-private-proxy-tenant")).toBe("synthetic-tenant");
  expect(request?.policy).toEqual({ allowedOrigins: ["https://private.example.invalid"] });
});

it.each([
  "not a URL",
  "file:///tmp/openrouter",
  `https://${["user", "pass"].join(":")}@private.example.invalid/v1`,
  "https://private.example.invalid/v1?token=synthetic-secret",
  "https://private.example.invalid/v1#synthetic-secret",
])("rejects malformed credential destinations before fetching: %s", async (baseUrl) => {
  const fetchGuard = vi
    .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
    .mockRejectedValue(new Error("Unexpected catalog fetch"));
  await expect(
    buildOpenrouterLiveProvider({ apiKey: "synthetic-private-key", baseUrl }),
  ).rejects.toThrow("Invalid OpenRouter API base URL");
  expect(fetchGuard).not.toHaveBeenCalled();
});

it("never sends non-secret API-key markers as catalog bearer credentials", async () => {
  const fetchGuard = catalogFetch([{ id: "private/model" }]);
  await buildOpenrouterLiveProvider({
    apiKey: "OPENROUTER_API_KEY",
    baseUrl: "https://private.example.invalid/v1",
  });
  expect(requestHeaders(fetchGuard).has("authorization")).toBe(false);
});

it("isolates catalog caches by destination and request policy", async () => {
  const fetchGuard = catalogFetch([{ id: "private/model" }]);
  const base = { apiKey: "synthetic-private-key" };
  const tenantA = { headers: { "X-Private-Proxy-Tenant": "tenant-a" } };
  const tenantB = { headers: { "X-Private-Proxy-Tenant": "tenant-b" } };
  for (const [origin, request] of [
    ["first", tenantA],
    ["first", tenantB],
    ["second", tenantA],
    ["first", tenantA],
  ] as const) {
    await buildOpenrouterLiveProvider({
      ...base,
      baseUrl: `https://${origin}.invalid/v1`,
      request,
    });
  }
  expect(fetchGuard).toHaveBeenCalledTimes(3);
  expect(fetchGuard.mock.calls.map(([request]) => request.url)).toEqual([
    "https://first.invalid/v1/models",
    "https://first.invalid/v1/models",
    "https://second.invalid/v1/models",
  ]);
});

it("honors proxy routing, custom auth and private-network denial", async () => {
  const fetchGuard = catalogFetch([{ id: "private/model" }]);
  await buildOpenrouterLiveProvider({
    apiKey: "synthetic-original-key",
    baseUrl: "https://private.example.invalid/router/v1",
    request: {
      allowPrivateNetwork: false,
      auth: { mode: "header", headerName: "X-Proxy-Key", value: "synthetic-override-key" },
      proxy: { mode: "explicit-proxy", url: "https://corporate-proxy.example.invalid" },
    },
  });
  const request = fetchGuard.mock.calls[0]?.[0];
  const headers = new Headers(request?.init?.headers);
  expect(headers.get("x-proxy-key")).toBe("synthetic-override-key");
  expect(headers.has("authorization")).toBe(false);
  expect(request?.policy).toEqual({});
  expect(request?.dispatcherPolicy).toMatchObject({
    mode: "explicit-proxy",
    proxyUrl: "https://corporate-proxy.example.invalid",
  });
});

it("does not follow cross-origin catalog pagination with private credentials", async () => {
  const release = vi.fn(async () => undefined);
  const fetchGuard = vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard");
  fetchGuard.mockImplementation(async ({ url }) => ({
    response: Response.json({
      data: [{ id: "private/model" }],
      next: "https://attacker.example.invalid/models?page=2",
    }),
    finalUrl: url,
    release,
  }));
  await expect(privateCatalog()).rejects.toThrow("did not include a supported next page");
  expect(fetchGuard).toHaveBeenCalledOnce();
  const request = fetchGuard.mock.calls[0]?.[0];
  expect(request?.url).toBe("https://private.example.invalid/v1/models");
  expect(requestHeaders(fetchGuard).get("authorization")).toBe("Bearer synthetic-private-key");
  expect(release).toHaveBeenCalledOnce();
});

it("strips private headers after a guarded cross-origin redirect", async () => {
  let requestCount = 0;
  const redirectedUrl = "https://redirect.example.invalid/catalog";
  const fetchGuard = vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard");
  fetchGuard.mockImplementation(async ({ url }) => {
    requestCount += 1;
    return {
      response: Response.json({
        data: [{ id: `private/model-${requestCount}` }],
        ...(requestCount === 1 ? { next: `${redirectedUrl}?page=2` } : {}),
      }),
      finalUrl: requestCount === 1 ? redirectedUrl : url,
      release: async () => undefined,
    };
  });
  await privateCatalog({
    request: { headers: { "X-Private-Proxy-Tenant": "synthetic-secret-tenant" } },
  });
  expect(fetchGuard).toHaveBeenCalledTimes(2);
  const redirectedHeaders = new Headers(fetchGuard.mock.calls[1]?.[0].init?.headers);
  expect(redirectedHeaders.has("authorization")).toBe(false);
  expect(redirectedHeaders.has("x-private-proxy-tenant")).toBe(false);
});

it("rejects unresolved request secrets before discovery", async () => {
  const fetchGuard = vi
    .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
    .mockRejectedValue(new Error("Unexpected catalog fetch"));
  await expect(
    privateCatalog({
      request: {
        headers: {
          "X-Private-Proxy-Tenant": {
            source: "env",
            provider: "default",
            id: "SYNTHETIC_MISSING_SECRET",
          },
        },
      },
    }),
  ).rejects.toThrow();
  expect(fetchGuard).not.toHaveBeenCalled();
});
