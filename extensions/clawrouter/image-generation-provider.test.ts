import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { buffer } from "node:stream/consumers";
import { generateImage } from "openclaw/plugin-sdk/image-generation-runtime";
import type {
  OpenClawConfig,
  UnifiedModelCatalogProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { acquireTestPortBlock, useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const MODEL = "openai/gpt-image-2.5-flare";
// A valid 1x1 PNG, independent of the adapter's parser.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=",
  "base64",
);
const authStore = {
  version: 1,
  profiles: {
    "clawrouter:locked": {
      type: "api_key" as const,
      provider: "clawrouter",
      key: "synthetic-router-key",
    },
    "openai:default": {
      type: "api_key" as const,
      provider: "openai",
      key: "synthetic-upstream-key",
    },
  },
};
function catalog() {
  return {
    version: "clawrouter.client-catalog.v1",
    providers: [
      {
        id: "openai",
        allowed: true,
        executable: true,
        models: [
          {
            id: MODEL,
            capabilities: ["image.generation"],
            pricing: {
              unit: "image_token",
              generation: {
                maxPromptCharacters: 32_000,
                maxImages: 10,
                dimensionMultiple: 16,
                minPixels: 655_360,
                maxPixels: 8_294_400,
                maxEdge: 3840,
                maxAspectRatio: 3,
              },
            },
          },
        ],
        offers: [
          {
            endpoint: "images_generations",
            modelId: MODEL,
            transport: "http",
            routeKind: "unified",
            route: "/v1/images/generations",
            eligible: true,
            affordability: "request-dependent",
          },
        ],
      },
    ],
  };
}

describe("registered ClawRouter image generation over HTTP", () => {
  useIsolatedStateGuard();
  let captured: ReturnType<typeof createCapturedPluginRegistration>;
  let baseUrl: string;
  let externalResultUrl: string;
  const proxyTargets: string[] = [];
  const proxySockets = new Set<Duplex>();
  let cfg: OpenClawConfig;
  let payload: unknown;
  let inventory: unknown;
  let status: number;
  let catalogStatus: number;
  let resultType: string;
  let resultLength: number | undefined;
  let holdPath: string | undefined;
  let onHeld: (response: ServerResponse) => void = () => {};
  const calls: Array<{
    url: string;
    method?: string;
    headers: IncomingHttpHeaders;
    body: unknown;
  }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const body = await buffer(request);
      calls.push({
        url: request.url ?? "",
        method: request.method,
        headers: request.headers,
        body: body.length ? JSON.parse(body.toString()) : undefined,
      });
      response.setHeader("Content-Type", "application/json");
      if (request.url === holdPath) {
        if (request.url === "/result.png") {
          response.setHeader("Content-Type", "image/png");
        }
        response.writeHead(200);
        response.write(request.url === "/result.png" ? PNG.subarray(0, 8) : '{"data":[');
        onHeld(response);
        return;
      }
      if (request.url === "/v1/catalog") {
        response.statusCode = catalogStatus;
        response.end(JSON.stringify(inventory));
      } else if (request.url === "/v1/images/generations") {
        response.statusCode = status;
        response.end(JSON.stringify(payload));
      } else if (request.url === "/result.png") {
        response.setHeader("Content-Type", resultType);
        if (resultLength) {
          response.setHeader("Content-Length", resultLength);
        }
        // Exercise the real streaming byte cap, not a false Content-Length alone.
        response.end(resultLength ? Buffer.alloc(resultLength) : PNG);
      } else {
        response.statusCode = 404;
        response.end();
      }
    })().catch((failure: unknown) => {
      response.destroy(failure instanceof Error ? failure : undefined);
    });
  });
  const storageServer = createServer((request, response) => {
    calls.push({
      url: request.url ?? "",
      method: request.method,
      headers: request.headers,
      body: undefined,
    });
    response.setHeader("Content-Type", "image/png");
    response.end(PNG);
  });
  storageServer.on("connect", (request, socket, head) => {
    proxyTargets.push(request.url ?? "");
    const target = new URL(baseUrl);
    const upstream = connect(Number(target.port), target.hostname);
    for (const owned of [socket, upstream]) {
      proxySockets.add(owned);
      owned.once("close", () => proxySockets.delete(owned));
    }
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) {
        upstream.write(head);
      }
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.once("close", () => upstream.destroy());
  });
  let releasePort: () => Promise<void>;
  beforeAll(async () => {
    const claim = await acquireTestPortBlock({ offsets: [0, 1] });
    releasePort = claim.release;
    server.listen(claim.port, "127.0.0.1");
    await once(server, "listening");
    storageServer.listen(claim.port + 1, "127.0.0.1");
    await once(storageServer, "listening");
    baseUrl = "http://127.0.0.1:" + claim.port;
    externalResultUrl = "http://127.0.0.1:" + (claim.port + 1) + "/external-result.png";
    captured = createCapturedPluginRegistration();
    plugin.register?.(captured.api);
  });
  afterAll(async () => {
    for (const socket of proxySockets) {
      socket.destroy();
    }
    for (const ownedServer of [server, storageServer]) {
      const closed = ownedServer[Symbol.asyncDispose]();
      ownedServer.closeAllConnections();
      await closed;
    }
    await releasePort();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    calls.length = 0;
    proxyTargets.length = 0;
    payload = { data: [{ b64_json: PNG.toString("base64") }] };
    inventory = catalog();
    status = 200;
    catalogStatus = 200;
    resultType = "image/png";
    resultLength = undefined;
    holdPath = undefined;
    onHeld = () => {};
    cfg = {
      models: {
        providers: {
          clawrouter: { api: "openai-responses", baseUrl, apiKey: "clawrouter:locked", models: [] },
        },
      },
    };
  });
  const generate = (overrides: Partial<Parameters<typeof generateImage>[0]> = {}) =>
    generateImage(
      {
        cfg,
        authStore,
        prompt: "Synthetic blue square",
        modelOverride: "clawrouter/" + MODEL,
        autoProviderFallback: false,
        timeoutMs: 2000,
        ...overrides,
      },
      {
        getProvider: (id) =>
          captured.imageGenerationProviders.find((provider) => provider.id === id),
        listProviders: () => captured.imageGenerationProviders,
        log: { warn() {} },
      },
    );
  // Generation can settle before the held response arrives (for example, its deadline expires during
  // pre-dispatch work); surface that settlement instead of waiting for a response that never comes.
  const awaitHeld = async (held: Promise<ServerResponse>, pending: Promise<unknown>) => {
    const first = await Promise.race([
      held,
      pending.then(
        () => undefined,
        () => undefined,
      ),
    ]);
    if (first) {
      return first;
    }
    await pending;
    return expect.fail("generation settled before the held response arrived");
  };

  it("routes the registered native runtime through same-key catalog and returns decoded image bytes", async () => {
    const result = await generate({
      size: "1024x1024",
      quality: "medium",
      outputFormat: "png",
      count: 1,
    });
    expect(result).toMatchObject({ provider: "clawrouter", model: MODEL });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ buffer: PNG, mimeType: "image/png" });
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", "/v1/catalog"],
      ["POST", "/v1/images/generations"],
    ]);
    expect(calls.map((call) => call.headers.authorization)).toEqual([
      "Bearer synthetic-router-key",
      "Bearer synthetic-router-key",
    ]);
    expect(calls[1]?.body).toEqual({
      model: MODEL,
      prompt: "Synthetic blue square",
      n: 1,
      size: "1024x1024",
      quality: "medium",
      output_format: "png",
    });
  });

  it("fetches same-origin result URLs without forwarding either credential", async () => {
    payload = { data: [{ url: baseUrl + "/result.png" }] };
    const result = await generate();
    expect(result.images[0]).toMatchObject({ buffer: PNG, mimeType: "image/png" });
    expect(calls.map((call) => call.url)).toEqual([
      "/v1/catalog",
      "/v1/images/generations",
      "/result.png",
    ]);
    expect(calls[2]?.headers.authorization).toBeUndefined();
  });

  it.each(["text/html", "oversize", "private-host"])(
    "rejects unsafe result download: %s",
    async (mode) => {
      resultType = mode === "text/html" ? "text/html" : "image/png";
      resultLength = mode === "oversize" ? 64 * 1024 * 1024 + 1 : undefined;
      payload = {
        data: [
          {
            url: mode === "private-host" ? externalResultUrl : baseUrl + "/result.png",
          },
        ],
      };
      await expect(generate({ timeoutMs: 10_000 })).rejects.toThrow(
        mode === "text/html"
          ? /expected an image Content-Type/
          : mode === "oversize"
            ? /exceed|large|limit/i
            : /private|blocked|allowed/i,
      );
      expect(calls.filter((call) => call.url === "/v1/images/generations")).toHaveLength(1);
      if (mode === "private-host") {
        expect(calls).toHaveLength(2);
      }
    },
  );

  it.each([false, true])(
    "honors explicit private-network permission %s across generation and storage origins",
    async (allowPrivateNetwork) => {
      cfg.models!.providers!.clawrouter!.request = { allowPrivateNetwork };
      payload = { data: [{ url: externalResultUrl }] };
      if (!allowPrivateNetwork) {
        await expect(generate()).rejects.toThrow(/private|blocked|allowed/i);
        expect(calls).toHaveLength(0);
        return;
      }
      const result = await generate();
      expect(result.images[0]).toMatchObject({ buffer: PNG, mimeType: "image/png" });
      expect(calls.map((call) => call.url)).toEqual([
        "/v1/catalog",
        "/v1/images/generations",
        "/external-result.png",
      ]);
      expect(calls[2]?.headers.authorization).toBeUndefined();
    },
  );

  it("uses the environment proxy for both required catalog and generation requests", async () => {
    const proxyUrl = new URL(externalResultUrl).origin;
    for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
      vi.stubEnv(name, proxyUrl);
    }
    for (const name of ["NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"]) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", undefined);
    const target = new URL(baseUrl);
    target.hostname = "clawrouter-proxy.invalid";
    cfg.models!.providers!.clawrouter!.baseUrl = target.origin;
    const result = await generate();
    expect(result.images[0]).toMatchObject({ buffer: PNG, mimeType: "image/png" });
    expect(calls.map((call) => call.url)).toEqual(["/v1/catalog", "/v1/images/generations"]);
    expect(proxyTargets).toEqual([target.host, target.host]);
    expect(calls.map((call) => call.headers.authorization)).toEqual([
      "Bearer synthetic-router-key",
      "Bearer synthetic-router-key",
    ]);
  });

  it("installs the caller's longer generation deadline instead of the default ceiling", async () => {
    // Observe real timers without replacing scheduling or waiting three minutes;
    // the held-response case below separately proves deadline expiry and release.
    const timers = vi.spyOn(globalThis, "setTimeout");
    const result = await generate({ timeoutMs: 300_000 });
    expect(result.images[0]).toMatchObject({ buffer: PNG, mimeType: "image/png" });
    const generationTimers = timers.mock.calls.filter(
      (call) => call[5] === "fetchWithSsrFGuard" && call[6] === baseUrl + "/v1/images/generations",
    );
    expect(generationTimers.length).toBeGreaterThan(0);
    for (const timer of generationTimers) {
      expect(timer[1]).toBeGreaterThan(180_000);
      expect(timer[1]).toBeLessThanOrEqual(300_000);
    }
  });

  it.each([401, 402, 403, 429])(
    "preserves generation HTTP %i without retry or upstream fallback",
    async (code) => {
      status = code;
      payload = { error: { message: "synthetic-router-key Synthetic blue square" } };
      const message = String(await generate().catch((failure: unknown) => failure));
      expect(message).toContain("HTTP " + code);
      expect(message).not.toContain("synthetic-router-key");
      expect(message).not.toContain("Synthetic blue square");
      expect(calls.map((call) => call.url)).toEqual(["/v1/catalog", "/v1/images/generations"]);
    },
  );

  it.each([401, 403, 429])("stops catalog HTTP %i before any image purchase", async (code) => {
    catalogStatus = code;
    inventory = { error: { message: "synthetic-router-key" } };
    const message = String(await generate().catch((failure: unknown) => failure));
    expect(message).toContain("HTTP " + code);
    expect(message).not.toContain("synthetic-router-key");
    expect(calls.map((call) => call.url)).toEqual(["/v1/catalog"]);
  });

  it("uses a newly resolved key without retaining old grants", async () => {
    await generate();
    calls.length = 0;
    inventory = { version: "clawrouter.client-catalog.v1", providers: [] };
    const changed = {
      version: 1,
      profiles: {
        ...authStore.profiles,
        "clawrouter:locked": {
          type: "api_key" as const,
          provider: "clawrouter",
          key: "synthetic-rotated-key",
        },
      },
    };
    await expect(generate({ authStore: changed })).rejects.toThrow(/catalog/);
    expect(calls.map((call) => [call.url, call.headers.authorization])).toEqual([
      ["/v1/catalog", "Bearer synthetic-rotated-key"],
    ]);
  });

  it("preserves the entitled sunburst snapshot ID and generation options", async () => {
    const snapshot = "openai/gpt-image-2.5-sunburst-2026-09-08";
    const granted = catalog();
    granted.providers[0]!.models[0]!.id = snapshot;
    granted.providers[0]!.offers[0]!.modelId = snapshot;
    inventory = granted;
    await generate({
      modelOverride: "clawrouter/" + snapshot,
      background: "transparent",
      providerOptions: { openai: { moderation: "low", user: "synthetic-user" } },
    });
    expect(calls[1]?.body).toEqual({
      model: snapshot,
      prompt: "Synthetic blue square",
      n: 1,
      background: "transparent",
      moderation: "low",
      user: "synthetic-user",
    });
  });

  it.each([
    {},
    { data: [] },
    { data: "bad" },
    { data: [{ b64_json: "%%%" }] },
    { data: [{ b64_json: "bm90IGFuIGltYWdl" }] },
  ])("rejects malformed generated output without buying another image: %j", async (value) => {
    payload = value;
    await expect(generate()).rejects.toThrow(/image|malformed/i);
    expect(calls.filter((call) => call.url === "/v1/images/generations")).toHaveLength(1);
  });

  it.each([
    "empty",
    "unknown",
    "no-offers",
    "ineligible",
    "blocked",
    "wrong-route",
    "wrong-capability",
    "not-allowed",
    "unknown-limits",
    "outage",
  ])("fails closed for catalog %s, even after a successful same-key request", async (mode) => {
    await generate();
    calls.length = 0;
    const next = catalog();
    const provider = next.providers[0]!;
    if (mode === "empty") {
      next.providers = [];
    } else if (mode === "no-offers") {
      provider.offers = [];
    } else if (mode === "ineligible") {
      provider.offers[0]!.eligible = false;
    } else if (mode === "blocked") {
      provider.offers[0]!.affordability = "exact-blocked";
    } else if (mode === "wrong-route") {
      provider.offers[0]!.routeKind = "native";
    } else if (mode === "wrong-capability") {
      provider.models[0]!.capabilities = ["llm.responses"];
    } else if (mode === "not-allowed") {
      provider.allowed = false;
    } else if (mode === "unknown-limits") {
      provider.models[0]!.pricing.unit = "token";
    } else if (mode === "outage") {
      catalogStatus = 503;
    }
    inventory = mode === "unknown" ? { providers: [] } : next;
    await expect(generate()).rejects.toThrow(/catalog|503/);
    expect(calls.map((call) => call.url)).toEqual(["/v1/catalog"]);
  });

  it.each(["count", "prompt", "dimensions"])(
    "enforces current catalog %s bounds before purchase",
    async (mode) => {
      const granted = catalog();
      const limits = granted.providers[0]!.models[0]!.pricing.generation;
      limits.maxImages = 1;
      limits.maxPromptCharacters = 32;
      inventory = granted;
      await expect(
        generate(
          mode === "count"
            ? { count: 2 }
            : mode === "prompt"
              ? { prompt: "x".repeat(33) }
              : { size: "1000x1000" },
        ),
      ).rejects.toThrow(/catalog/);
      expect(calls.map((call) => call.url)).toEqual(["/v1/catalog"]);
    },
  );

  it.each(["openai/gpt-image-2", "openai/gpt-5.5", "google/gemini-3.1-flash-image"])(
    "rejects unsupported model %s before network dispatch",
    async (model) => {
      await expect(generate({ modelOverride: "clawrouter/" + model })).rejects.toThrow(
        /Unsupported ClawRouter image model/,
      );
      expect(calls).toHaveLength(0);
    },
  );

  it("rejects edits and streaming before dispatch", async () => {
    await expect(
      generate({ inputImages: [{ buffer: PNG, mimeType: "image/png" }] }),
    ).rejects.toThrow(/reference|editing|support/i);
    await expect(generate({ providerOptions: { stream: true } })).rejects.toThrow(
      /only JSON generation/,
    );
    expect(calls).toHaveLength(0);
  });

  it("does not replace a broken selected profile with an upstream or other router credential", async () => {
    await expect(
      generate({
        authStore: {
          version: 1,
          profiles: {
            ...authStore.profiles,
            "clawrouter:locked": { type: "api_key", provider: "clawrouter", key: "" },
            "clawrouter:other": {
              type: "api_key",
              provider: "clawrouter",
              key: "wrong-router-key",
            },
          },
        },
      }),
    ).rejects.toThrow(/profile|resolve|credential/i);
    expect(calls).toHaveLength(0);
  });

  it.each(["/v1/catalog", "/v1/images/generations", "/result.png"])(
    "cancels and releases the held HTTP body at %s",
    async (path) => {
      holdPath = path;
      if (path === "/result.png") {
        payload = { data: [{ url: baseUrl + "/result.png" }] };
      }
      const { promise: held, resolve: resolveHeld } = Promise.withResolvers<ServerResponse>();
      onHeld = resolveHeld;
      const controller = new AbortController();
      const pending = generate({ signal: controller.signal });
      const settled = pending.catch(() => undefined);
      const response = await awaitHeld(held, pending);
      const closed = once(response, "close");
      controller.abort(new Error("synthetic caller cancelled"));
      await expect(pending).rejects.toThrow(/abort|cancel/i);
      await closed;
      await settled;
      expect(response.destroyed).toBe(true);
      expect(calls.filter((call) => call.url === "/v1/images/generations")).toHaveLength(
        path === "/v1/catalog" ? 0 : 1,
      );
    },
  );

  it("times out and releases a held generation response without retry", async () => {
    // Complete one ordinary generation so the 500ms budget below covers the held response, not
    // first-use auth/catalog setup in a fresh worker.
    await generate();
    calls.length = 0;
    holdPath = "/v1/images/generations";
    const { promise: held, resolve: resolveHeld } = Promise.withResolvers<ServerResponse>();
    onHeld = resolveHeld;
    const pending = generate({ timeoutMs: 500 });
    const settled = pending.catch(() => undefined);
    const response = await awaitHeld(held, pending);
    const closed = once(response, "close");
    await expect(pending).rejects.toThrow(/timeout|timed out|abort/i);
    await closed;
    await settled;
    expect(calls.filter((call) => call.url === "/v1/images/generations")).toHaveLength(1);
  });

  it("publishes only same-key entitled image rows through the registered catalog family", async () => {
    // Catalog discovery uses a literal synthetic key; runtime tests above use a real profile binding.
    cfg.models!.providers!.clawrouter!.apiKey = "synthetic-router-key";
    const selected = captured.modelCatalogProviders.find((provider) =>
      provider.kinds.includes("image_generation"),
    );
    expect(selected).toBeDefined();
    const context: UnifiedModelCatalogProviderContext = {
      config: cfg,
      env: {},
      includeLive: true,
      resolveProviderApiKey: () => ({
        apiKey: "synthetic-router-key",
        discoveryApiKey: "synthetic-router-key",
      }),
      resolveProviderAuth: () => ({
        apiKey: "synthetic-router-key",
        discoveryApiKey: "synthetic-router-key",
        mode: "api_key",
        source: "env",
      }),
    };
    const entitled = catalog();
    entitled.providers[0]!.models[0]!.pricing.generation.maxImages = 2;
    inventory = entitled;
    const rows = await selected!.liveCatalog!(context);
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "image_generation",
        provider: "clawrouter",
        model: MODEL,
        modes: ["generate"],
        capabilities: expect.objectContaining({
          generate: expect.objectContaining({ maxCount: 2 }),
        }),
      }),
    ]);
    inventory = { version: "clawrouter.client-catalog.v1", providers: [] };
    await expect(selected!.liveCatalog!(context)).resolves.toEqual([]);
    expect(
      calls.every((call) => call.headers.authorization === "Bearer synthetic-router-key"),
    ).toBe(true);
  });
});
