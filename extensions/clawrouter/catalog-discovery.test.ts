import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  CATALOG_DISCOVERY_CONTRACTS,
  type CatalogDiscoveryProvider,
} from "./catalog-discovery-contracts.js";
import {
  DISCOVERY_BASE,
  DISCOVERY_ID,
  DISCOVERY_PROVIDERS,
  discoveryCatalog,
  discoveryPayload,
} from "./catalog-discovery.test-support.js";
import plugin from "./index.js";

let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
beforeAll(async () => {
  provider = await registerSingleProviderPlugin(plugin);
});
beforeEach(() => clearLiveCatalogCacheForTests());
afterEach(() => {
  vi.restoreAllMocks();
  clearLiveCatalogCacheForTests();
});

it("discovery observations never become upstream request parameters", async () => {
  fixture("baseten");
  const config = await acquire();
  const row = config.models[0];
  if (!row) {
    throw new Error("Expected a discovered model");
  }
  const stream = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
  const wrapped = provider.wrapStreamFn?.({
    provider: "clawrouter",
    modelId: row.id,
    streamFn: stream,
  });
  if (!wrapped) {
    throw new Error("Expected the registered ClawRouter stream wrapper");
  }
  await wrapped(
    {
      id: row.id,
      name: row.name,
      provider: "clawrouter",
      api: "openai-completions",
      baseUrl: config.baseUrl,
      reasoning: false,
      input: ["text"],
      params: row.params,
      cost: row.cost,
      maxTokens: row.maxTokens,
      contextWindow: row.contextWindow,
    },
    { messages: [] },
  );
  expect(stream).toHaveBeenCalledTimes(1);
  expect(stream.mock.calls[0]?.[0].params?.clawrouterDiscovery).toBeUndefined();
});

async function acquire(
  options: { key?: string; profile?: string; origin?: string; signal?: AbortSignal } = {},
) {
  const apiKey = options.key ?? "synthetic-proxy-key";
  const context: ProviderCatalogContext = {
    config: {
      models: {
        providers: {
          clawrouter: { baseUrl: `${options.origin ?? DISCOVERY_BASE}/v1`, models: [] },
        },
      },
    },
    env: { OPENAI_API_KEY: "synthetic-unused-vendor-key" },
    signal: options.signal,
    resolveProviderApiKey: () => ({ apiKey, discoveryApiKey: apiKey, profileId: options.profile }),
    resolveProviderAuth: () => ({
      apiKey,
      discoveryApiKey: apiKey,
      profileId: options.profile,
      mode: "api_key",
      source: "profile",
    }),
  };
  const result = await provider.catalog?.run(context);
  if (!result || !("provider" in result)) {
    throw new Error("Expected registered ClawRouter catalog");
  }
  return result.provider;
}

function fixture(family: CatalogDiscoveryProvider, kind: "native" | "manifest" = "manifest") {
  const catalog = discoveryCatalog(family, kind);
  let payload: unknown = discoveryPayload(family);
  const release = vi.fn(async () => undefined);
  const guard = vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async (params) => ({
    response: Response.json(params.url.endsWith("/v1/catalog") ? catalog : payload),
    finalUrl: params.url,
    release,
  }));
  return {
    catalog,
    guard,
    release,
    setPayload: (value: unknown) => {
      payload = value;
    },
  };
}

const routes = DISCOVERY_PROVIDERS.flatMap((family) =>
  ("manifestOnly" in CATALOG_DISCOVERY_CONTRACTS[family]
    ? ["manifest" as const]
    : ["manifest" as const, "native" as const]
  ).map((kind) => ({ family, kind })),
);
it.each(routes)(
  "registered catalog consumes $family/$kind with its original proxy key",
  async ({ family, kind }) => {
    const f = fixture(family, kind);
    const result = await acquire();
    expect(result.models.map((row) => row.id)).toEqual([`${family}/${DISCOVERY_ID}`]);
    const model = result.models[0];
    expect(model?.cost).toBeUndefined();
    expect(model?.maxTokens).toBe(["arcee", "cerebras"].includes(family) ? 512 : undefined);
    expect(model?.contextWindow).toBe(
      ["arcee", "cerebras", "nvidia", "novita"].includes(family) ? 4096 : undefined,
    );
    expect(model?.params?.clawrouterDiscovery).toMatchObject({
      provider: family,
      upstream: DISCOVERY_ID,
    });
    expect(f.guard).toHaveBeenCalledTimes(2);
    const request = f.guard.mock.calls[1]?.[0];
    expect(request?.url).toBe(DISCOVERY_BASE + f.catalog.providers[0]!.offers[0]!.route);
    expect(request?.init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    expect(request?.init?.body).toBeUndefined();
    expect(new Headers(request?.init?.headers).get("authorization")).toBe(
      "Bearer synthetic-proxy-key",
    );
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.guard.mock.calls[1]?.[0].timeoutMs).toBeLessThanOrEqual(
      f.guard.mock.calls[0]?.[0].timeoutMs ?? 0,
    );
  },
);

it.each(DISCOVERY_PROVIDERS)(
  "fresh complete empty %s suppresses every static seed",
  async (family) => {
    const f = fixture(family);
    expect((await acquire()).models).toHaveLength(1);
    clearLiveCatalogCacheForTests();
    f.setPayload(discoveryPayload(family, true));
    expect((await acquire()).models).toEqual([]);
    expect((await acquire()).models).toEqual([]);
    expect(f.guard).toHaveBeenCalledTimes(4);
  },
);

it("keeps original key, profile and origin caches separate", async () => {
  const f = fixture("bifrost");
  await acquire({ profile: "one" });
  await acquire({ profile: "one" });
  expect(f.guard).toHaveBeenCalledTimes(2);
  await acquire({ profile: "two" });
  await acquire({ profile: "two", key: "synthetic-second-key" });
  await acquire({
    profile: "two",
    key: "synthetic-second-key",
    origin: "https://second-router.example",
  });
  expect(f.guard).toHaveBeenCalledTimes(8);
  expect(new Headers(f.guard.mock.calls[5]?.[0].init?.headers).get("authorization")).toBe(
    "Bearer synthetic-second-key",
  );
});

it.each(["foreign-route", "wrong-format", "ineligible", "native-public"])(
  "denies unqualified offer %s before discovery egress",
  async (denial) => {
    const f = fixture("cerebras", denial === "native-public" ? "native" : "manifest");
    if (denial === "foreign-route") {
      f.catalog.providers[0]!.offers[0]!.route = "/v1/proxy/nvidia/public_models";
    }
    if (denial === "wrong-format") {
      f.catalog.providers[0]!.routes[0]!.requestFormat = "openai.models";
    }
    if (denial === "ineligible") {
      f.catalog.providers[0]!.offers[0]!.eligible = false;
    }
    await acquire();
    expect(f.guard).toHaveBeenCalledTimes(1);
  },
);

it.each([
  { providerId: "nvidia", catalog: [] },
  { providerId: "featherless", catalog: [], next: "/v1/proxy/foreign/catalog" },
  { data: [], pagination: { current_page: 1, total_pages: 2 } },
  [],
])("rejects malformed/foreign/paged Featherless data without another GET: %j", async (payload) => {
  const f = fixture("featherless");
  f.setPayload(payload);
  await expect(acquire()).rejects.toThrow(/catalog/);
  expect(f.guard).toHaveBeenCalledTimes(2);
  expect(f.release).toHaveBeenCalledTimes(2);
});

it("never revives Baseten decision rows through Chat discovery", async () => {
  const f = fixture("baseten");
  f.setPayload({
    data: [{ id: "decision-models/system-one" }, { id: DISCOVERY_ID, pricing: { prompt: "0" } }],
  });
  const result = await acquire();
  expect(result.models.map((row) => row.id)).toEqual([`baseten/${DISCOVERY_ID}`]);
  expect(result.models[0]?.params?.clawrouterDiscovery).toMatchObject({
    observations: { pricing: { prompt: "0" } },
  });
});

it("rejects DeepInfra's unpublished internal envelope and keeps opaque LiteLLM aliases", async () => {
  const f = fixture("deepinfra");
  f.setPayload({ models: [], availability: [] });
  await expect(acquire()).rejects.toThrow(/catalog/);
  clearLiveCatalogCacheForTests();
  vi.restoreAllMocks();
  const other = fixture("litellm");
  other.setPayload({ object: "list", data: [{ object: "model", id: "Team/Policy@West" }] });
  expect((await acquire()).models[0]?.id).toBe("litellm/Team/Policy@West");
});

it("caller abort before acquisition performs no GET", async () => {
  const f = fixture("chutes"),
    controller = new AbortController();
  controller.abort(new Error("fixture cancellation"));
  await expect(acquire({ signal: controller.signal })).rejects.toThrow("fixture cancellation");
  expect(f.guard).not.toHaveBeenCalled();
});

it("caller cancellation during a held body never publishes partial rows and retains bounded shared-load cleanup", async () => {
  const f = fixture("chutes"),
    controller = new AbortController();
  let held!: ReadableStreamDefaultController<Uint8Array>;
  const started = Promise.withResolvers<void>(),
    released = Promise.withResolvers<void>();
  f.guard.mockImplementation(async (params) => ({
    response: params.url.endsWith("/v1/catalog")
      ? Response.json(f.catalog)
      : new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              held = stream;
              stream.enqueue(new TextEncoder().encode('{"object":"list","data":['));
              started.resolve();
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    finalUrl: params.url,
    release: async () => {
      if (!params.url.endsWith("/v1/catalog")) {
        released.resolve();
      }
    },
  }));
  const pending = acquire({ signal: controller.signal });
  await started.promise;
  controller.abort(new Error("fixture cancellation"));
  await expect(pending).rejects.toThrow("fixture cancellation");
  held.error(new Error("fixture truncated response"));
  await released.promise;
  expect(f.guard).toHaveBeenCalledTimes(2);
});

it.each([302, 401, 500, 206])(
  "HTTP %s never becomes seed fallback or another credential attempt",
  async (status) => {
    const f = fixture("requesty");
    f.guard.mockImplementation(async (params) => ({
      response: params.url.endsWith("/v1/catalog")
        ? Response.json(f.catalog)
        : new Response("", { status, headers: { "content-type": "application/json" } }),
      finalUrl: params.url,
      release: f.release,
    }));
    await expect(acquire()).rejects.toThrow(/HTTP 200/);
    expect(f.guard).toHaveBeenCalledTimes(2);
    expect(f.release).toHaveBeenCalledTimes(2);
  },
);

it("preserves the current catalog's exact upstream-to-card binding", async () => {
  const f = fixture("bifrost");
  f.catalog.providers[0]!.models[0]!.id = "bifrost/declared-card";
  f.catalog.providers[0]!.models[0]!.upstream = DISCOVERY_ID;
  expect((await acquire()).models[0]?.id).toBe("bifrost/declared-card");
});

it("retains only exact current router pricing, including zero, across persistence", async () => {
  const f = fixture("baseten");
  Object.assign(f.catalog.providers[0]!.models[0]!, {
    id: "baseten/declared-card",
    upstream: DISCOVERY_ID,
    pricing: { inputMicrosPerMillion: 0 },
  });
  const model = (await acquire()).models[0];
  expect(model?.cost).toMatchObject({ input: 0 });
  expect(model?.cost?.output).toBeUndefined();
  expect(model?.cost?.cacheRead).toBeUndefined();
  expect(model?.cost?.cacheWrite).toBeUndefined();
  expect(model?.contextWindow).toBeUndefined();
  expect(model?.maxTokens).toBeUndefined();
  const storedModel = JSON.stringify(model);
  const persisted: unknown = JSON.parse(storedModel);
  expect(persisted).toMatchObject({
    cost: { input: 0 },
    params: { clawrouterDiscovery: { observations: { pricing: { prompt: "0" } } } },
  });
  expect(persisted).not.toHaveProperty("maxTokens");
  expect(persisted).not.toHaveProperty("contextWindow");
});

it("keeps Requesty Chat policy names while excluding regional and non-Chat rows", async () => {
  const f = fixture("requesty");
  f.setPayload({
    data: [
      { id: "MyPolicy", api: "chat", input_price: 0 },
      { id: "MyPolicy@region", api: "chat" },
      { id: "embedding", api: "embeddings" },
    ],
  });
  const result = await acquire();
  expect(result.models.map((row) => row.id)).toEqual(["requesty/MyPolicy"]);
  expect(result.models[0]?.cost).toBeUndefined();
  expect(result.models[0]?.params?.clawrouterDiscovery).toMatchObject({
    observations: { pricing: { input_price: 0 } },
  });
});

it.each(["truncated", "oversized", "malformed"])(
  "failed %s bodies neither cache partial rows nor retry another route",
  async (failure) => {
    const f = fixture("litellm");
    f.guard.mockImplementation(async (params) => ({
      response: params.url.endsWith("/v1/catalog")
        ? Response.json(f.catalog)
        : failure === "truncated"
          ? new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"object":"list","data":['));
                  controller.error(new Error("fixture socket loss"));
                },
              }),
              { headers: { "content-type": "application/json" } },
            )
          : new Response(failure === "oversized" ? " ".repeat(4 * 1024 * 1024 + 1) : "{", {
              headers: { "content-type": "application/json" },
            }),
      finalUrl: params.url,
      release: f.release,
    }));
    await expect(acquire()).rejects.toBeDefined();
    expect(f.guard).toHaveBeenCalledTimes(2);
    expect(f.release).toHaveBeenCalledTimes(2);
    f.guard.mockImplementation(async (params) => ({
      response: Response.json(
        params.url.endsWith("/v1/catalog") ? f.catalog : discoveryPayload("litellm"),
      ),
      finalUrl: params.url,
      release: f.release,
    }));
    expect((await acquire()).models).toHaveLength(1);
    expect(f.guard).toHaveBeenCalledTimes(3);
  },
);
