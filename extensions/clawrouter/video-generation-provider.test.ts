import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { buffer } from "node:stream/consumers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import * as http from "openclaw/plugin-sdk/provider-http";
import { acquireTestPortBlock, useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { generateVideo } from "openclaw/plugin-sdk/video-generation-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pixversePlugin from "../pixverse/index.js";
import plugin from "./index.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=",
  "base64",
);
const CREATE = "/v1/native/pixverse/openapi/v2/video/img/generate";
const RETRIEVE = "/v1/native/pixverse/openapi/v2/video/result/42";
const OUTPUT = "https://media.example/opaque.mp4?token=synthetic";
const profile = "clawrouter.pixverse-image-input.v1";
const authStore = {
  version: 1,
  profiles: {
    "clawrouter:fixture": {
      type: "api_key" as const,
      provider: "clawrouter",
      key: "synthetic-router-key",
    },
    "pixverse:fixture": {
      type: "api_key" as const,
      provider: "pixverse",
      key: "synthetic-upstream-key",
    },
  },
};
function catalog(model: string) {
  return {
    version: "clawrouter.client-catalog.v1",
    observedAt: new Date().toISOString(),
    scope: { authType: "proxy_key", credentialId: "synthetic-credential" },
    providers: [
      {
        id: "pixverse",
        allowed: true,
        executable: true,
        nativeBaseUrl: "/v1/native/pixverse",
        routes: [
          {
            endpoint: "image_video",
            path: "/openapi/v2/video/img/generate",
            methods: ["POST"],
            inputProfile: profile,
            requestFormat: "pixverse.image_video",
            responseFormat: "pixverse.video",
          },
        ],
        models: [{ id: model, upstream: model.slice(9), capabilities: ["video.generate"] }],
        offers: [
          {
            endpoint: "image_video",
            modelId: model,
            transport: "http",
            eligible: true,
            affordability: "request-dependent",
            routeKind: "native",
            route: CREATE,
            inputProfile: profile,
          },
        ],
      },
    ],
  };
}

describe("registered ClawRouter PixVerse generation over HTTP", () => {
  useIsolatedStateGuard();
  const calls: { path: string; headers: IncomingHttpHeaders; method?: string; body: Buffer }[] = [];
  let captured: ReturnType<typeof createCapturedPluginRegistration>;
  let cfg: OpenClawConfig;
  let baseUrl: string;
  let model: string;
  let inventory: ReturnType<typeof catalog> | undefined;
  let failure:
    | "lost"
    | "malformed"
    | "foreign"
    | "failed"
    | "empty"
    | "oversize"
    | "held"
    | "redirect"
    | "poll-redirect"
    | undefined;
  let onCreate: () => void;
  let peerClosed: Promise<void> | undefined;
  let releasePort: () => Promise<void>;
  const server = createServer((request, response) => {
    void (async () => {
      const body = await buffer(request);
      const path = request.url ?? "";
      calls.push({ path, method: request.method, headers: request.headers, body });
      response.setHeader("Content-Type", "application/json");
      if (path === "/v1/catalog") {
        response.end(JSON.stringify(inventory ?? catalog(model)));
      } else if (path === CREATE) {
        onCreate();
        if (failure === "lost") {
          response.destroy();
          return;
        }
        if (failure === "redirect") {
          response.writeHead(307, { location: baseUrl + "/direct/openapi/v2/video/img/generate" });
          response.end();
          return;
        }
        if (failure === "held") {
          peerClosed = once(response, "close").then(() => undefined);
          response.write('{"ErrCode":0,"Resp":');
          return;
        }
        response.end(
          failure === "malformed"
            ? '{"ErrCode":0'
            : failure === "oversize"
              ? " ".repeat(1024 * 1024 + 1)
              : JSON.stringify({ ErrCode: 0, Resp: { video_id: 42 } }),
        );
      } else if (path === RETRIEVE) {
        if (failure === "poll-redirect") {
          response.writeHead(307, { location: baseUrl + "/foreign-result" });
          response.end();
          return;
        }
        response.end(
          JSON.stringify({
            ErrCode: 0,
            Resp: {
              video_id: failure === "foreign" ? 43 : 42,
              status: failure === "failed" ? 8 : 1,
              url: failure === "empty" ? "" : OUTPUT,
            },
          }),
        );
      } else if (path === "/direct/openapi/v2/image/upload") {
        response.end(JSON.stringify({ ErrCode: 0, Resp: { img_id: 7 } }));
      } else if (path === "/direct/openapi/v2/video/img/generate") {
        response.end(JSON.stringify({ ErrCode: 0, Resp: { video_id: 42 } }));
      } else if (path === "/direct/openapi/v2/video/result/42") {
        response.end(JSON.stringify({ ErrCode: 0, Resp: { status: 1, url: OUTPUT } }));
      } else {
        response.statusCode = 404;
        response.end();
      }
    })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
  });
  beforeAll(async () => {
    const claim = await acquireTestPortBlock({ offsets: [0] });
    releasePort = claim.release;
    server.listen(claim.port, "127.0.0.1");
    await once(server, "listening");
    baseUrl = "http://127.0.0.1:" + claim.port;
    captured = createCapturedPluginRegistration();
    plugin.register?.(captured.api);
    pixversePlugin.register?.(captured.api);
  });
  afterAll(async () => {
    const closed = server[Symbol.asyncDispose]();
    server.closeAllConnections();
    await closed;
    await releasePort();
  });
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    calls.length = 0;
    model = "pixverse/v6";
    inventory = undefined;
    failure = undefined;
    onCreate = () => {};
    peerClosed = undefined;
    cfg = {
      agents: {
        defaults: {
          mediaModels: { video: { primary: "clawrouter/pixverse/v6", fallbacks: ["pixverse/v6"] } },
        },
      },
      models: {
        providers: {
          clawrouter: {
            api: "openai-responses",
            baseUrl,
            apiKey: "clawrouter:fixture",
            models: [],
          },
          pixverse: {
            api: "openai-completions",
            baseUrl: baseUrl + "/direct/openapi/v2",
            apiKey: "pixverse:fixture",
            request: { allowPrivateNetwork: true },
            models: [],
          },
        },
      },
    };
  });
  const generate = (overrides: Partial<Parameters<typeof generateVideo>[0]> = {}) =>
    generateVideo(
      {
        cfg,
        authStore,
        prompt: "Synthetic moving square",
        inputImages: [{ buffer: PNG, mimeType: "image/png" }],
        timeoutMs: 10_000,
        autoProviderFallback: false,
        ...overrides,
      },
      {
        getProvider: (id) =>
          captured.videoGenerationProviders.find((provider) => provider.id === id),
        listProviders: () => captured.videoGenerationProviders,
        getProviderEnvVars: () => [],
        log: { warn() {}, debug() {} },
      },
    );
  const expectSoleCreate = () => {
    expect(calls.filter((call) => call.path === CREATE)).toHaveLength(1);
    expect(calls.filter((call) => call.path.startsWith("/direct/"))).toEqual([]);
    expect(
      calls.every((call) => call.headers.authorization === "Bearer synthetic-router-key"),
    ).toBe(true);
  };
  it.each(["pixverse/v6", "pixverse/c1"])(
    "uses the registered runtime, selected Router key and one composed upload for %s",
    async (id) => {
      model = id;
      cfg.agents!.defaults!.mediaModels!.video = {
        primary: "clawrouter/" + id,
        fallbacks: ["pixverse/v6"],
      };
      const result = await generate({
        audio: true,
        durationSeconds: 6,
        resolution: "720p",
        providerOptions: { seed: 17 },
      });
      expect(result.provider).toBe("clawrouter");
      expect(result.videos).toEqual([{ url: OUTPUT, mimeType: "video/mp4" }]);
      expect(result.metadata).toMatchObject({ videoId: "42", status: 1 });
      expect(calls.map((call) => [call.method, call.path])).toEqual([
        ["GET", "/v1/catalog"],
        ["POST", CREATE],
        ["GET", RETRIEVE],
      ]);
      expectSoleCreate();
      const created = calls[1]!;
      expect(created.headers["idempotency-key"]).toMatch(/^[a-z0-9-]{36}$/u);
      const form = await new Request(baseUrl + CREATE, {
        method: "POST",
        headers: { "content-type": String(created.headers["content-type"]) },
        body: Uint8Array.from(created.body),
      }).formData();
      expect(form.get("model")).toBe(id.slice(9));
      expect(form.get("seed")).toBe("17");
      expect(form.get("duration")).toBe("6");
      expect(form.get("quality")).toBe("720p");
      expect(form.get("generate_audio_switch")).toBe("true");
      expect(form.get("img_id")).toBeNull();
      expect(Buffer.from(await (form.get("image") as File).arrayBuffer())).toEqual(PNG);
      expect(calls.some((call) => call.path.includes("opaque.mp4"))).toBe(false);
    },
  );
  it.each([
    "lost",
    "malformed",
    "foreign",
    "failed",
    "empty",
    "oversize",
    "redirect",
    "poll-redirect",
  ] as const)("does not replay or use direct credentials after %s", async (mode) => {
    failure = mode;
    await expect(generate()).rejects.toBeInstanceOf(Error);
    expectSoleCreate();
  });
  it("retires an unfinished create response on its real operation deadline without fallback", async () => {
    failure = "held";
    await expect(generate({ timeoutMs: 1500 })).rejects.toBeInstanceOf(Error);
    expectSoleCreate();
    expect(peerClosed).toBeDefined();
    await peerClosed;
  });
  it("continues only the original GET with the original key after local credential rotation", async () => {
    const selectedStore = structuredClone(authStore);
    onCreate = () => {
      selectedStore.profiles["clawrouter:fixture"].key = "synthetic-rotated-key";
    };
    expect((await generate({ authStore: selectedStore })).videos[0]!.url).toBe(OUTPUT);
    expectSoleCreate();
    expect(calls[2]!.headers.authorization).toBe("Bearer synthetic-router-key");
  });
  it("retains ordinary direct upload-then-JSON fallback for a known pre-dispatch catalog denial", async () => {
    inventory = catalog(model);
    inventory.providers[0]!.offers = [];
    expect((await generate()).provider).toBe("pixverse");
    expect(calls.map((call) => call.path)).toEqual([
      "/v1/catalog",
      "/direct/openapi/v2/image/upload",
      "/direct/openapi/v2/video/img/generate",
      "/direct/openapi/v2/video/result/42",
    ]);
    expect(calls[2]!.headers["api-key"]).toBe("synthetic-upstream-key");
    expect(JSON.parse(calls[2]!.body.toString()).img_id).toBe(7);
  });
  it.each(["manifest", "stale", "revoked", "profile", "model"])(
    "does not submit an ineligible %s catalog offer",
    async (mode) => {
      inventory = catalog(model);
      if (mode === "manifest") {
        inventory.providers[0]!.offers[0]!.routeKind = "manifest";
        inventory.providers[0]!.offers[0]!.route = "/v1/proxy/pixverse/image_video";
      } else if (mode === "stale") {
        inventory.observedAt = "2000-01-01T00:00:00Z";
      } else if (mode === "revoked") {
        inventory.providers[0]!.allowed = false;
      } else if (mode === "profile") {
        inventory.providers[0]!.offers[0]!.inputProfile = "foreign";
      } else {
        inventory.providers[0]!.models[0]!.upstream = "foreign";
      }
      await expect(generate({ modelOverride: "clawrouter/pixverse/v6" })).rejects.toThrow();
      expect(calls.map((call) => call.path)).toEqual(["/v1/catalog"]);
    },
  );
  it("refreshes the selected credential's entitlement and withdraws a previously accepted model", async () => {
    await generate();
    const rotatedStore = structuredClone(authStore);
    rotatedStore.profiles["clawrouter:fixture"].key = "synthetic-new-router-key";
    inventory = catalog(model);
    inventory.providers[0]!.offers = [];
    const before = calls.length;
    await expect(
      generate({ modelOverride: "clawrouter/pixverse/v6", authStore: rotatedStore }),
    ).rejects.toThrow(/unavailable/u);
    expect(calls.slice(before).map((call) => call.path)).toEqual(["/v1/catalog"]);
    expect(calls[before]!.headers.authorization).toBe("Bearer synthetic-new-router-key");
  });
  it("retains malformed response and independent falsey release failures in source order", async () => {
    failure = "malformed";
    const actual = http.postMultipartRequest;
    let releases = 0;
    vi.spyOn(http, "postMultipartRequest").mockImplementation(async (args) => {
      const owned = await actual(args);
      return {
        ...owned,
        release: async () => {
          await owned.release();
          releases++;
          // Native cleanup may reject with no reason; retain that independent occurrence.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw undefined;
        },
      };
    });
    const caught = await generate().catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([expect.any(Error), undefined]);
    expect(releases).toBe(1);
    expectSoleCreate();
  });
  it.each([undefined, null, false, 0, "", Object.freeze(new Error("synthetic release failure"))])(
    "retains release failure identity or falsey cause %# without fallback",
    async (reason) => {
      const actual = http.postMultipartRequest;
      vi.spyOn(http, "postMultipartRequest").mockImplementation(async (args) => {
        const owned = await actual(args);
        return {
          ...owned,
          release: async () => {
            await owned.release();
            // Exercise legal JavaScript rejection values without replacing their identity.
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw reason;
          },
        };
      });
      const caught = await generate().then(
        () => {
          throw new Error("unexpected success");
        },
        (error: unknown) => error,
      );
      if (reason instanceof Error) {
        expect(caught).toBe(reason);
      } else {
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).cause).toBe(reason);
      }
      expectSoleCreate();
      expect(calls.some((call) => call.path === RETRIEVE)).toBe(false);
    },
  );
});
