import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { generateImage } from "openclaw/plugin-sdk/image-generation-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useIsolatedStateGuard, withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

const upstream = "gemini-3.1-flash-image";
const model = "google/" + upstream;
// Decoder-verified offline 2x2 PNG also used by the qualified Worker wrapper.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQI12NkYPj/n4GBgYGJAQoAHRkCAhxhMhsAAAAASUVORK5CYII=",
  "base64",
);
const payload = () => ({
  candidates: [
    {
      finishReason: "STOP",
      content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }] },
    },
  ],
});

async function fixture(
  run: (f: {
    cfg: OpenClawConfig;
    catalog: ReturnType<typeof imageCatalog>;
    listCatalog: () => Promise<unknown>;
    calls: Array<{
      url: string;
      method?: string;
      auth?: string;
      googleKey?: string;
      body: unknown;
    }>;
    generate: (
      overrides?: Partial<Parameters<typeof generateImage>[0]>,
    ) => ReturnType<typeof generateImage>;
  }) => Promise<void>,
  respond: (res: ServerResponse) => void = (res) => res.end(JSON.stringify(payload())),
) {
  const captured = createCapturedPluginRegistration();
  plugin.register?.(captured.api);
  const catalog = imageCatalog();
  const calls: Array<{
    url: string;
    method?: string;
    auth?: string;
    googleKey?: string;
    body: unknown;
  }> = [];
  await withServer(
    (req, res) => {
      void (async () => {
        const raw = await buffer(req);
        calls.push({
          url: req.url!,
          method: req.method,
          auth: req.headers.authorization,
          googleKey: req.headers["x-goog-api-key"] as string | undefined,
          body: raw.length ? JSON.parse(raw.toString()) : undefined,
        });
        res.setHeader("content-type", "application/json");
        if (req.url === "/v1/catalog") {
          res.end(JSON.stringify(catalog));
        } else {
          respond(res);
        }
      })().catch((error: unknown) =>
        res.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    },
    async (baseUrl) => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            clawrouter: {
              baseUrl,
              apiKey: "synthetic-router",
              models: [],
              request: { allowPrivateNetwork: true },
            },
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              apiKey: "synthetic-google-must-not-be-used",
              models: [],
            },
          },
        },
      };
      const generate = (overrides: Partial<Parameters<typeof generateImage>[0]> = {}) =>
        generateImage(
          {
            cfg,
            prompt: "Synthetic blue square",
            modelOverride: "clawrouter/" + model,
            autoProviderFallback: false,
            timeoutMs: 10_000,
            ...overrides,
          },
          {
            getProvider: (id) =>
              captured.imageGenerationProviders.find((provider) => provider.id === id),
            listProviders: () => captured.imageGenerationProviders,
            log: { warn() {} },
          },
        );
      const listCatalog = async () =>
        captured.modelCatalogProviders.find((provider) =>
          provider.kinds.includes("image_generation"),
        )!.liveCatalog!({
          config: cfg,
          env: {},
          includeLive: true,
          resolveProviderApiKey: () => ({
            apiKey: "synthetic-router",
            discoveryApiKey: "synthetic-router",
            mode: "api_key",
            source: "env",
          }),
          resolveProviderAuth: () => ({
            apiKey: "synthetic-router",
            discoveryApiKey: "synthetic-router",
            mode: "api_key",
            source: "env",
          }),
        });
      await run({ cfg, catalog, calls, generate, listCatalog });
    },
  );
}

function imageCatalog() {
  return {
    version: "clawrouter.client-catalog.v1",
    observedAt: new Date().toISOString(),
    scope: { authType: "proxy_key", credentialId: "synthetic-router-id" },
    providers: [
      {
        id: "google-gemini",
        allowed: true,
        executable: true,
        nativeBaseUrl: "/v1/native/google-gemini",
        routes: [
          {
            endpoint: "image_generate",
            path: "/v1beta/models/${model}:generateContent",
            methods: ["POST"],
            requestFormat: "google.image_generate",
            responseFormat: "google.image",
          },
        ],
        models: [{ id: model, upstream, capabilities: ["image.generate"] }],
        offers: [
          {
            endpoint: "image_generate",
            modelId: model,
            transport: "http",
            routeKind: "native",
            route: "/v1/native/google-gemini/v1beta/models/${model}:generateContent",
            eligible: true,
            affordability: "request-dependent",
          },
        ],
      },
    ],
  };
}

describe("ClawRouter native Google image consumer", () => {
  useIsolatedStateGuard();
  it.each(["native", "manifest"])(
    "uses actual image runtime and native codec through %s",
    async (route) => {
      await fixture(async ({ catalog, calls, generate }) => {
        const offer = catalog.providers[0]!.offers[0]!;
        offer.routeKind = route;
        if (route === "manifest") {
          offer.route = "/v1/proxy/google-gemini/image_generate";
        }
        const result = await generate({
          inputImages: [{ buffer: PNG, mimeType: "image/png" }],
          aspectRatio: "16:9",
          resolution: "2K",
        });
        expect(result).toMatchObject({
          provider: "clawrouter",
          model,
          images: [{ buffer: PNG, mimeType: "image/png" }],
        });
        expect(calls).toHaveLength(2);
        expect(calls.map((call) => call.auth)).toEqual([
          "Bearer synthetic-router",
          "Bearer synthetic-router",
        ]);
        expect(calls.every((call) => call.googleKey === undefined)).toBe(true);
        const body = {
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } },
                { text: "Synthetic blue square" },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
          },
        };
        expect(calls[1]!.url).toBe(
          route === "native"
            ? `/v1/native/google-gemini/v1beta/models/${upstream}:generateContent`
            : "/v1/proxy/google-gemini/image_generate",
        );
        expect(calls[1]!.body).toEqual(
          route === "native" ? body : { body, pathParams: { model: upstream } },
        );
      });
    },
  );

  it("publishes qualified per-model image capabilities and withdraws revoked offers", async () => {
    await fixture(async ({ catalog, calls, listCatalog }) => {
      expect(await listCatalog()).toEqual([
        expect.objectContaining({
          model,
          modes: ["generate", "edit"],
          capabilities: expect.objectContaining({
            generate: expect.objectContaining({ maxCount: 1 }),
            edit: expect.objectContaining({ enabled: true, maxInputImages: 5 }),
          }),
        }),
      ]);
      catalog.providers[0]!.offers[0]!.eligible = false;
      expect(await listCatalog()).toEqual([]);
      expect(
        calls.every(
          (call) => call.url === "/v1/catalog" && call.auth === "Bearer synthetic-router",
        ),
      ).toBe(true);
    });
  });

  it("binds the second frozen model to its own manifest path parameter", async () => {
    await fixture(async ({ catalog, calls, generate }) => {
      const provider = catalog.providers[0]!;
      provider.models[0]!.id = "google/gemini-3-pro-image";
      provider.models[0]!.upstream = "gemini-3-pro-image";
      Object.assign(provider.offers[0]!, {
        modelId: "google/gemini-3-pro-image",
        routeKind: "manifest",
        route: "/v1/proxy/google-gemini/image_generate",
      });
      await generate({ modelOverride: "clawrouter/google/gemini-3-pro-image" });
      expect(calls[1]!.body).toMatchObject({ pathParams: { model: "gemini-3-pro-image" } });
    });
  });

  it.each([
    "stale",
    "scope",
    "revoked",
    "model",
    "capability",
    "request format",
    "response format",
    "path",
    "foreign origin",
  ])("denies %s offers before generation", async (invalid) => {
    await fixture(async ({ catalog, calls, generate }) => {
      const provider = catalog.providers[0]!,
        route = provider.routes[0]!;
      if (invalid === "stale") {
        catalog.observedAt = "2000-01-01T00:00:00Z";
      }
      if (invalid === "scope") {
        catalog.scope.authType = "access";
      }
      if (invalid === "revoked") {
        provider.offers[0]!.eligible = false;
      }
      if (invalid === "model") {
        provider.models[0]!.upstream = "gemini-3-flash-preview";
      }
      if (invalid === "capability") {
        provider.models[0]!.capabilities = ["llm.chat"];
      }
      if (invalid === "request format") {
        route.requestFormat = "google.generate_content";
      }
      if (invalid === "response format") {
        route.responseFormat = "google.text";
      }
      if (invalid === "path") {
        route.path = "/v1beta/models/${model}:streamGenerateContent";
      }
      if (invalid === "foreign origin") {
        provider.offers[0]!.route = "https://foreign.example/generate";
      }
      await expect(generate()).rejects.toThrow(/catalog|offer/);
      expect(calls).toHaveLength(1);
    });
  });

  it.each([
    "count",
    "HEIC",
    "references",
    "provider options",
    "foreign credential",
    "missing proxy key",
  ])("denies %s before catalog or paid dispatch", async (invalid) => {
    await fixture(async ({ cfg, calls, generate }) => {
      if (invalid === "foreign credential") {
        cfg.models!.providers!.clawrouter!.headers = { "x-goog-api-key": "synthetic-foreign" };
      }
      if (invalid === "missing proxy key") {
        delete cfg.models!.providers!.clawrouter!.apiKey;
      }
      await expect(
        generate({
          ...(invalid === "count" ? { count: 2 } : {}),
          ...(invalid === "HEIC" ? { inputImages: [{ buffer: PNG, mimeType: "image/heic" }] } : {}),
          ...(invalid === "references"
            ? {
                inputImages: Array.from({ length: 6 }, () => ({
                  buffer: PNG,
                  mimeType: "image/png",
                })),
              }
            : {}),
          ...(invalid === "provider options"
            ? { providerOptions: { google: { cachedContent: "unowned" } } }
            : {}),
        }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });
  });

  it.each(["partial", "thought", "missing MIME", "invalid sibling"])(
    "rejects %s output without replay",
    async (invalid) => {
      await fixture(
        async ({ calls, generate }) => {
          await expect(generate()).rejects.toThrow(/image/);
          expect(calls).toHaveLength(2);
        },
        (res) => {
          const body = payload();
          if (invalid === "partial") {
            body.candidates[0]!.finishReason = "MAX_TOKENS";
          }
          if (invalid === "thought") {
            Object.assign(body.candidates[0]!.content.parts[0]!, { thought: true });
          }
          if (invalid === "missing MIME") {
            body.candidates[0]!.content.parts[0]!.inlineData.mimeType = "";
          }
          if (invalid === "invalid sibling") {
            body.candidates[0]!.content.parts.push({
              inlineData: { mimeType: "image/png", data: "bad" },
            });
          }
          res.end(JSON.stringify(body));
        },
      );
    },
  );

  it.each(["output bytes", "image count"])("bounds %s through the actual host", async (bound) => {
    await fixture(
      async ({ calls, generate }) => {
        await expect(generate()).rejects.toThrow(/bounds/);
        expect(calls).toHaveLength(2);
      },
      (res) => {
        const body = payload();
        if (bound === "output bytes") {
          body.candidates[0]!.content.parts[0]!.inlineData.data = Buffer.concat([
            PNG,
            Buffer.alloc(4 * 1024 * 1024),
          ]).toString("base64");
        } else {
          body.candidates[0]!.content.parts = Array.from(
            { length: 5 },
            () => payload().candidates[0]!.content.parts[0]!,
          );
        }
        res.end(JSON.stringify(body));
      },
    );
  });

  it("bounds native request JSON before catalog lookup", async () => {
    await fixture(async ({ calls, generate }) => {
      await expect(generate({ prompt: "x".repeat(8 * 1024 * 1024) })).rejects.toThrow(/8 MiB/);
      expect(calls).toHaveLength(0);
    });
  });

  it("keeps cancellation active through response EOF without replay", async () => {
    const started = createDeferred(),
      closed = createDeferred();
    await fixture(
      async ({ calls, generate }) => {
        const caller = new AbortController();
        const pending = generate({ signal: caller.signal });
        const rejected = expect(pending).rejects.toThrow(/abort|cancel/i);
        await Promise.race([started.promise, pending]);
        caller.abort();
        await rejected;
        await closed.promise;
        expect(calls).toHaveLength(2);
      },
      (res) => {
        res.write('{"candidates":[');
        res.once("close", () => closed.resolve());
        started.resolve();
      },
    );
  });

  it.each([
    ["native", "same-origin"],
    ["manifest", "same-origin"],
    ["native", "second-server"],
    ["manifest", "second-server"],
  ])("rejects %s image redirects to %s without credential egress", async (route, destination) => {
    let destinationRequests = 0;
    await withServer(
      (_req, res) => {
        destinationRequests++;
        res.end(JSON.stringify(payload()));
      },
      async (destinationOrigin) => {
        await fixture(
          async ({ catalog, calls, generate }) => {
            const offer = catalog.providers[0]!.offers[0]!;
            offer.routeKind = route;
            if (route === "manifest") {
              offer.route = "/v1/proxy/google-gemini/image_generate";
            }
            const error = await generate().catch((caught: unknown) => caught);
            expect(String(error)).not.toContain("synthetic-router");
            expect(String(error)).toMatch(/redirect|fetch/i);
            const generationPosts = calls.filter((call) => call.method === "POST");
            expect(generationPosts).toHaveLength(1);
            expect(generationPosts[0]).toMatchObject({
              url:
                route === "manifest"
                  ? "/v1/proxy/google-gemini/image_generate"
                  : "/v1/native/google-gemini/v1beta/models/gemini-3.1-flash-image:generateContent",
              auth: "Bearer synthetic-router",
              googleKey: undefined,
            });
            expect(calls).toHaveLength(2);
            expect(calls.some((call) => call.url === "/redirect-target")).toBe(false);
            expect(destinationRequests).toBe(0);
          },
          (res) => {
            if (res.req.url === "/redirect-target") {
              destinationRequests++;
              res.end(JSON.stringify(payload()));
              return;
            }
            res.statusCode = 307;
            res.setHeader(
              "location",
              destination === "same-origin"
                ? "/redirect-target"
                : `${destinationOrigin}/redirect-target`,
            );
            res.end();
          },
        );
      },
    );
  });
});
