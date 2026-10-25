import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { generateImage } from "openclaw/plugin-sdk/image-generation-runtime";
import type {
  OpenClawConfig,
  UnifiedModelCatalogProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { acquireTestPortBlock, useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import plugin from "./index.js";

const MODEL = "openai/gpt-image-2.5-flare";
// A valid 1x1 PNG, independent of the adapter's parser.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=",
  "base64",
);
const apiKeyProfile = (provider: string, key: string) => ({
  type: "api_key" as const,
  provider,
  key,
});
const authStore = {
  version: 1,
  profiles: {
    "clawrouter:locked": apiKeyProfile("clawrouter", "synthetic-router-key"),
    "openai:default": apiKeyProfile("openai", "synthetic-upstream-key"),
  },
};
function catalog(model = MODEL) {
  return {
    version: "clawrouter.client-catalog.v1",
    providers: [
      {
        id: "openai",
        allowed: true,
        executable: true,
        models: [
          {
            id: model,
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
            modelId: model,
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
    for (const ownedServer of [server, storageServer]) {
      const closed = ownedServer[Symbol.asyncDispose]();
      ownedServer.closeAllConnections();
      await closed;
    }
    await releasePort();
  });
  beforeEach(() => {
    calls.length = 0;
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
    const snapshot = "openai/gpt-image-2.5-sunburst-2026-09-08";
    const granted = catalog(snapshot);
    inventory = granted;
    const result = await generate({
      modelOverride: "clawrouter/" + snapshot,
      size: "1024x1024",
      quality: "medium",
      outputFormat: "png",
      background: "transparent",
      providerOptions: { openai: { moderation: "low", user: "synthetic-user" } },
    });
    expect(result).toMatchObject({ provider: "clawrouter", model: snapshot });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ buffer: PNG, mimeType: "image/png" });
    expect(calls.map((call) => [call.method, call.url, call.headers.authorization])).toEqual([
      ["GET", "/v1/catalog", "Bearer synthetic-router-key"],
      ["POST", "/v1/images/generations", "Bearer synthetic-router-key"],
    ]);
    expect(calls[1]?.body).toEqual({
      model: snapshot,
      prompt: "Synthetic blue square",
      n: 1,
      size: "1024x1024",
      quality: "medium",
      output_format: "png",
      background: "transparent",
      moderation: "low",
      user: "synthetic-user",
    });
  });

  it("fetches same-origin result URLs without forwarding either credential", async () => {
    payload = { data: [{ url: baseUrl + "/result.png" }] };
    const result = await generate();
    expect(result.images[0]).toMatchObject({ buffer: PNG, mimeType: "image/png" });
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
      expect(calls[2]?.headers.authorization).toBeUndefined();
    },
  );

  it.each(["catalog", "generation"])(
    "keeps %s HTTP failures terminal and private",
    async (stage) => {
      if (stage === "catalog") {
        catalogStatus = 403;
        inventory = { error: { message: "synthetic-router-key Synthetic blue square" } };
      } else {
        status = 403;
        payload = { error: { message: "synthetic-router-key Synthetic blue square" } };
      }
      const message = String(await generate().catch((failure: unknown) => failure));
      expect(message).toContain("HTTP 403");
      expect(message).not.toContain("synthetic-router-key");
      expect(message).not.toContain("Synthetic blue square");
      expect(calls.map((call) => call.url)).toEqual(
        stage === "catalog" ? ["/v1/catalog"] : ["/v1/catalog", "/v1/images/generations"],
      );
    },
  );

  it("uses a newly resolved key without retaining old grants", async () => {
    await generate();
    calls.length = 0;
    inventory = { version: "clawrouter.client-catalog.v1", providers: [] };
    const changed = {
      version: 1,
      profiles: {
        ...authStore.profiles,
        "clawrouter:locked": apiKeyProfile("clawrouter", "synthetic-rotated-key"),
      },
    };
    await expect(generate({ authStore: changed })).rejects.toThrow(/catalog/);
    expect(calls.map((call) => [call.url, call.headers.authorization])).toEqual([
      ["/v1/catalog", "Bearer synthetic-rotated-key"],
    ]);
  });

  it("rejects non-image output without buying another image", async () => {
    payload = { data: [{ b64_json: "bm90IGFuIGltYWdl" }] };
    await expect(generate()).rejects.toThrow(/image|malformed/i);
    expect(calls.filter((call) => call.url === "/v1/images/generations")).toHaveLength(1);
  });

  const revoke: Record<string, (next: ReturnType<typeof catalog>) => void> = {
    empty: (c) => (c.providers = []),
    unknown: (c) => (c.version = "unknown"),
    "no-offers": (c) => (c.providers[0]!.offers = []),
    ineligible: (c) => (c.providers[0]!.offers[0]!.eligible = false),
    blocked: (c) => (c.providers[0]!.offers[0]!.affordability = "exact-blocked"),
    "wrong-route": (c) => (c.providers[0]!.offers[0]!.routeKind = "native"),
    "wrong-capability": (c) => (c.providers[0]!.models[0]!.capabilities = ["llm.responses"]),
    "not-allowed": (c) => (c.providers[0]!.allowed = false),
    "unknown-limits": (c) => (c.providers[0]!.models[0]!.pricing.unit = "token"),
    outage: () => (catalogStatus = 503),
  };
  it.each(Object.entries(revoke))(
    "fails closed after catalog %s revocation",
    async (_mode, change) => {
      await generate();
      calls.length = 0;
      const next = catalog();
      change(next);
      inventory = next;
      await expect(generate()).rejects.toThrow(/catalog|503/);
      expect(calls.map((call) => call.url)).toEqual(["/v1/catalog"]);
    },
  );

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

  it("rejects unsupported models before network dispatch", async () => {
    await expect(generate({ modelOverride: "clawrouter/openai/gpt-image-2" })).rejects.toThrow(
      /Unsupported ClawRouter image model/,
    );
    expect(calls).toHaveLength(0);
  });

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
            "clawrouter:locked": apiKeyProfile("clawrouter", ""),
            "clawrouter:other": apiKeyProfile("clawrouter", "wrong-router-key"),
          },
        },
      }),
    ).rejects.toThrow(/profile|resolve|credential/i);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["/v1/catalog", false],
    ["/v1/images/generations", false],
    ["/result.png", false],
    ["/v1/images/generations", true],
  ] as const)("releases held %s (deadline=%s) without retry", async (path, deadline) => {
    if (deadline) {
      // Warm auth/catalog before spending the existing 500 ms body deadline.
      await generate();
      calls.length = 0;
    }
    holdPath = path;
    if (path === "/result.png") {
      payload = { data: [{ url: baseUrl + "/result.png" }] };
    }
    const held = Promise.withResolvers<ServerResponse>();
    onHeld = held.resolve;
    const controller = new AbortController();
    const pending = generate(deadline ? { timeoutMs: 500 } : { signal: controller.signal });
    const settled = pending.catch(() => undefined);
    const response = await awaitHeld(held.promise, pending);
    const closed = once(response, "close");
    if (!deadline) {
      controller.abort(new Error("synthetic caller cancelled"));
    }
    await expect(pending).rejects.toThrow(deadline ? /timeout|timed out|abort/i : /abort|cancel/i);
    await closed;
    await settled;
    expect(response.destroyed).toBe(true);
    expect(calls.filter((call) => call.url === "/v1/images/generations")).toHaveLength(
      path === "/v1/catalog" ? 0 : 1,
    );
  });

  it("publishes only same-key entitled image rows through the registered catalog family", async () => {
    // Catalog discovery uses a literal synthetic key; runtime tests above use a real profile binding.
    cfg.models!.providers!.clawrouter!.apiKey = "synthetic-router-key";
    const selected = captured.modelCatalogProviders.find((provider) =>
      provider.kinds.includes("image_generation"),
    );
    const resolveAuth = () => ({
      apiKey: "synthetic-router-key",
      discoveryApiKey: "synthetic-router-key",
      mode: "api_key" as const,
      source: "env" as const,
    });
    const context: UnifiedModelCatalogProviderContext = {
      config: cfg,
      env: {},
      includeLive: true,
      resolveProviderApiKey: resolveAuth,
      resolveProviderAuth: resolveAuth,
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
