import { once } from "node:events";
import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import type { EmbeddingProviderCreateOptions } from "openclaw/plugin-sdk/embedding-providers";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { acquireTestPortBlock, useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("registered ClawRouter memory embeddings", () => {
  useIsolatedStateGuard();
  const captured = createCapturedPluginRegistration();
  plugin.register?.(captured.api);
  let baseUrl: string;
  let releasePort: () => Promise<void>;
  let options: EmbeddingProviderCreateOptions;
  let eligible = true;
  let routeKind = "native";
  let format = "openai.embeddings";
  const calls: Array<{ path: string; auth?: string; body?: Record<string, unknown> }> = [];
  const route = () =>
    routeKind === "unified"
      ? "/v1/embeddings"
      : routeKind === "manifest"
        ? "/v1/proxy/openai/embeddings"
        : "/v1/native/openai/v1/embeddings";
  const server = createServer((request, response) => {
    void (async () => {
      const bytes = await buffer(request);
      const body = bytes.length
        ? (JSON.parse(bytes.toString()) as Record<string, unknown>)
        : undefined;
      const payload =
        routeKind === "manifest" ? (body?.body as Record<string, unknown> | undefined) : body;
      const inputs = Array.isArray(payload?.input) ? payload.input : [];
      calls.push({ path: request.url ?? "", auth: request.headers.authorization, body });
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/v1/catalog"
            ? {
                version: "clawrouter.client-catalog.v1",
                providers: [
                  {
                    id: "openai",
                    nativeBaseUrl: "/v1/native/openai",
                    allowed: true,
                    executable: true,
                    models: [
                      {
                        id: "openai/text-embedding-3-small",
                        upstream: "text-embedding-3-small",
                        capabilities: ["llm.embeddings"],
                      },
                    ],
                    routes: [
                      {
                        endpoint: "embeddings",
                        path: "/v1/embeddings",
                        methods: ["POST"],
                        requestFormat: format,
                        responseFormat: format,
                      },
                    ],
                    offers: [
                      {
                        endpoint: "embeddings",
                        modelId: "openai/text-embedding-3-small",
                        routeKind,
                        route: route(),
                        transport: "http",
                        eligible,
                        affordability: "request-dependent",
                      },
                    ],
                  },
                ],
              }
            : {
                data: inputs
                  .map((_: unknown, index: number) => ({
                    index,
                    embedding: [index + 1, index + 2],
                  }))
                  .toReversed(),
                usage: { prompt_tokens: 2, total_tokens: 2 },
              },
        ),
      );
    })().catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  beforeAll(async () => {
    const claim = await acquireTestPortBlock({ offsets: [0] });
    releasePort = claim.release;
    server.listen(claim.port, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${claim.port}/v1`;
  });
  afterAll(async () => {
    const closed = server[Symbol.asyncDispose]();
    server.closeAllConnections();
    await closed;
    await releasePort();
  });
  beforeEach(() => {
    eligible = true;
    routeKind = "native";
    format = "openai.embeddings";
    calls.length = 0;
    options = {
      config: {
        models: {
          providers: {
            clawrouter: { baseUrl, models: [] },
            openai: {
              baseUrl: "https://upstream.example/v1",
              apiKey: "unused-upstream-key",
              models: [],
            },
          },
        },
      },
      model: "openai/text-embedding-3-small",
      remote: { apiKey: "synthetic-router-key" },
    };
  });
  const adapter = () =>
    captured.embeddingProviders.find((provider) => provider.id === "clawrouter")!;

  it.each(["native", "manifest", "unified"])(
    "uses the %s offer through the memory transport",
    async (kind) => {
      routeKind = kind;
      const { provider } = await adapter().create(options);
      const onUsage = vi.fn();
      expect(await provider!.embedBatch(["first", "second"], { onUsage })).toEqual([
        [1, 2],
        [2, 3],
      ]);
      expect(onUsage).toHaveBeenCalledOnce();
      expect(calls).toEqual([
        { path: "/v1/catalog", auth: "Bearer synthetic-router-key", body: undefined },
        {
          path: route(),
          auth: "Bearer synthetic-router-key",
          body:
            kind === "manifest"
              ? {
                  body: { model: "text-embedding-3-small", input: ["first", "second"] },
                }
              : {
                  model: kind === "unified" ? options.model : "text-embedding-3-small",
                  input: ["first", "second"],
                },
        },
      ]);
      expect(provider!.model).toBe(options.model);
    },
  );

  it("refreshes the selected key and grant before every memory request", async () => {
    const { provider } = await adapter().create(options);
    await provider!.embed("first");
    options.remote!.apiKey = "rotated-router-key";
    eligible = false;
    await expect(provider!.embed("denied")).rejects.toThrow("no eligible");
    expect(calls).toHaveLength(3);
    expect(calls.at(-1)).toMatchObject({ path: "/v1/catalog", auth: "Bearer rotated-router-key" });
  });

  it("does not forward a router credential to a remote override or fall back upstream", async () => {
    options.config.models!.providers!.clawrouter!.apiKey = "synthetic-router-key";
    options.remote = { baseUrl: "https://another-router.example/v1" };
    const { provider } = await adapter().create(options);
    await expect(provider!.embed("private text")).rejects.toThrow("credentials are not configured");
    expect(calls).toEqual([]);
  });

  it("rejects unknown formats, unsupported inputs and cancelled requests before dispatch", async () => {
    const { provider } = await adapter().create(options);
    format = "future.embeddings";
    await expect(provider!.embed("unknown")).rejects.toThrow("no eligible");
    expect(calls).toHaveLength(1);
    await expect(
      provider!.embed({
        text: "image",
        parts: [{ type: "inline-data", mimeType: "image/png", data: "AA==" }],
      }),
    ).rejects.toThrow("text-only");
    const controller = new AbortController();
    controller.abort();
    await expect(provider!.embed("cancelled", { signal: controller.signal })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
