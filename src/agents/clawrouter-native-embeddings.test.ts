import { once } from "node:events";
import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCapturedPluginRegistration,
  getActivePluginRegistry,
  setActivePluginRegistry,
  createEmptyPluginRegistry,
  registerEmbeddingProvider,
} from "../plugin-sdk/plugin-test-runtime.js";
import { acquireTestPortBlock, useIsolatedStateGuard } from "../plugin-sdk/test-env.js";
import type {
  EmbeddingProviderCreateOptions,
  EmbeddingProviderCreateResult,
} from "../plugins/embedding-provider-types.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { resolveMemorySearchConfig } from "./memory-search.js";
type MemoryEmbeddingOptions = Omit<EmbeddingProviderCreateOptions, "dimensions"> & {
  provider: string;
  fallback: string;
  outputDimensionality?: number;
};

const axis = (dimensions: number) =>
  Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0));
const cases = [
  ["voyage", "voyage-4-large", "voyage.embeddings", 256],
  ["voyage", "voyage-4", "voyage.embeddings", 256],
  ["voyage", "voyage-4-lite", "voyage.embeddings", 256],
  ["cohere", "embed-v4.0", "cohere.embed", 256],
  ["google-gemini", "gemini-embedding-001", "google.embed_content", 128],
  ["google-gemini", "gemini-embedding-2", "google.batch_embed_contents", 128],
  ["google-gemini", "gemini-embedding-2-preview", "google.batch_embed_contents", 128],
  ["aws-bedrock", "amazon.titan-embed-text-v2:0", "aws_bedrock.invoke", 256],
  ["aws-bedrock", "amazon.titan-embed-text-v1", "aws_bedrock.invoke", 1536],
  ["aws-bedrock", "amazon.titan-embed-g1-text-02", "aws_bedrock.invoke", 1536],
  ["aws-bedrock", "amazon.titan-embed-image-v1", "aws_bedrock.invoke", 1024],
  ["aws-bedrock", "cohere.embed-english-v3", "aws_bedrock.invoke", 1024],
  ["aws-bedrock", "cohere.embed-multilingual-v3", "aws_bedrock.invoke", 1024],
  ["aws-bedrock", "global.cohere.embed-v4:0", "aws_bedrock.invoke", 256],
  ["aws-bedrock", "amazon.nova-2-multimodal-embeddings-v1:0", "aws_bedrock.invoke", 256],
  ["aws-bedrock", "us.twelvelabs.marengo-embed-2-7-v1:0", "aws_bedrock.invoke", 1024],
  ["aws-bedrock", "twelvelabs.marengo-embed-3-0-v1:0", "aws_bedrock.invoke", 512],
  ["google-gemini", "gemini-embedding-001", "google.batch_embed_contents", 128],
  ["google-gemini", "gemini-embedding-2", "google.embed_content", 128],
] as const;

describe("actual ClawRouter native memory embeddings", () => {
  useIsolatedStateGuard();
  const captured = createCapturedPluginRegistration();
  let memory: {
    createEmbeddingProvider: (
      options: MemoryEmbeddingOptions,
    ) => Promise<EmbeddingProviderCreateResult>;
  };
  let previousRegistry: ReturnType<typeof getActivePluginRegistry>;
  let baseUrl: string, releasePort: () => Promise<void>;
  let selected: readonly [string, string, string, number] = cases[0];
  let routeKind = "native",
    eligible = true,
    invalidTail = false;
  const wires: Array<{
    path: string;
    auth?: string;
    body: Record<string, unknown>;
    pathModel?: unknown;
  }> = [];
  const path = () =>
    selected[2] === "voyage.embeddings"
      ? "/v1/embeddings"
      : selected[2] === "cohere.embed"
        ? "/v2/embed"
        : selected[2] === "aws_bedrock.invoke"
          ? "/model/${model}/invoke"
          : "/v1beta/models/${model}:" +
            (selected[2] === "google.embed_content" ? "embedContent" : "batchEmbedContents");
  const endpoint = () => (selected[2] === "voyage.embeddings" ? "embeddings" : "embed");
  const route = () =>
    routeKind === "manifest"
      ? "/v1/proxy/" + selected[0] + "/" + endpoint()
      : "/v1/native/" + selected[0] + path();
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/catalog") {
        res.end(
          JSON.stringify({
            version: "clawrouter.client-catalog.v1",
            providers: [
              {
                id: selected[0],
                allowed: true,
                executable: true,
                nativeBaseUrl: "/v1/native/" + selected[0],
                models: [
                  {
                    id: selected[0] + "/" + selected[1],
                    upstream: selected[1],
                    capabilities: ["llm.embeddings"],
                  },
                ],
                routes: [
                  {
                    endpoint: endpoint(),
                    path: path(),
                    methods: ["POST"],
                    requestFormat: selected[2],
                    responseFormat: selected[2],
                  },
                ],
                offers: [
                  {
                    endpoint: endpoint(),
                    modelId: selected[0] + "/" + selected[1],
                    routeKind,
                    route: route(),
                    transport: "http",
                    eligible,
                    affordability: "request-dependent",
                  },
                ],
              },
            ],
          }),
        );
        return;
      }
      const envelope = JSON.parse((await buffer(req)).toString()) as Record<string, unknown>;
      const body = (routeKind === "manifest" ? envelope.body : envelope) as Record<string, unknown>;
      const pathModel = (envelope.pathParams as Record<string, unknown> | undefined)?.model;
      wires.push({ path: req.url ?? "", auth: req.headers.authorization, body, pathModel });
      // Google manifest selection requires the model path parameter, even for a batch body.
      if (
        routeKind === "manifest" &&
        selected[2].startsWith("google.") &&
        pathModel !== selected[1]
      ) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { code: "invalid_native_embedding_route" } }));
        return;
      }
      const count = Array.isArray(body.requests)
        ? body.requests.length
        : Array.isArray(body.texts)
          ? body.texts.length
          : Array.isArray(body.input)
            ? body.input.length
            : 1;
      const rows = Array.from({ length: count }, (_, i) =>
        invalidTail && i === count - 1 ? [1] : axis(selected[3]),
      );
      const payload =
        selected[2] === "voyage.embeddings"
          ? {
              data: rows.map((embedding, index) => ({ index, embedding })).toReversed(),
              usage: { total_tokens: 7 },
            }
          : selected[2] === "cohere.embed"
            ? { embeddings: { float: rows }, meta: { billed_units: { input_tokens: 7 } } }
            : selected[2] === "google.embed_content"
              ? { embedding: { values: rows[0] }, usageMetadata: { promptTokenCount: 7 } }
              : selected[2] === "google.batch_embed_contents"
                ? {
                    embeddings: rows.map((values) => ({ values })),
                    usageMetadata: { promptTokenCount: 7 },
                  }
                : selected[1].includes("cohere")
                  ? { embeddings: selected[1].includes("v4") ? { float: rows } : rows }
                  : selected[1].includes("nova")
                    ? { embeddings: [{ embedding: rows[0] }] }
                    : selected[1].includes("marengo")
                      ? { data: { embedding: rows[0] } }
                      : { embedding: rows[0], inputTextTokenCount: 7 };
      res.end(JSON.stringify(payload));
    })().catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  beforeAll(async () => {
    const entry = await loadBundledPluginFacade<{
      default: { register?: (api: typeof captured.api) => void };
    }>({
      pluginId: "clawrouter",
      artifactBasename: "index.js",
    });
    entry.default.register?.(captured.api);
    memory = await loadBundledPluginFacade<typeof memory>({
      pluginId: "memory-core",
      artifactBasename: "runtime-api.js",
    });
    const claim = await acquireTestPortBlock({ offsets: [0] });
    releasePort = claim.release;
    server.listen(claim.port, "127.0.0.1");
    await once(server, "listening");
    baseUrl = "http://127.0.0.1:" + claim.port + "/v1";
  });
  afterAll(async () => {
    const closed = server[Symbol.asyncDispose]();
    server.closeAllConnections();
    await closed;
    await releasePort();
  });
  afterEach(() => setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry()));
  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
    registerEmbeddingProvider(adapter());
    selected = cases[0];
    routeKind = "native";
    eligible = true;
    invalidTail = false;
    wires.length = 0;
  });
  const options = (): EmbeddingProviderCreateOptions => ({
    model: selected[0] + "/" + selected[1],
    dimensions: selected[3],
    config: {
      plugins: { enabled: false },
      models: {
        providers: {
          clawrouter: { baseUrl, models: [] },
          google: {
            apiKey: "unused-upstream-key",
            baseUrl: "https://upstream.example",
            models: [],
          },
        },
      },
    },
    remote: { apiKey: "synthetic-router-key" },
  });
  const adapter = () => captured.embeddingProviders.find((row) => row.id === "clawrouter")!;
  const create = ({ dimensions, ...value }: EmbeddingProviderCreateOptions) =>
    memory.createEmbeddingProvider({
      ...value,
      provider: "clawrouter",
      fallback: "none",
      outputDimensionality: dimensions,
    });
  it.each(cases)(
    "runs %s/%s through native and manifest memory consumers",
    async (id, model, format, dimensions) => {
      selected = [id, model, format, dimensions];
      for (const kind of ["native", "manifest"]) {
        routeKind = kind;
        wires.length = 0;
        const { provider } = await create(options());
        const onUsage = vi.fn();
        expect(await provider!.embed("query", { inputType: "query", onUsage })).toEqual(
          axis(dimensions),
        );
        expect(await provider!.embedBatch(["first", "second"], { inputType: "document" })).toEqual([
          axis(dimensions),
          axis(dimensions),
        ]);
        expect(wires.every((wire) => wire.auth === "Bearer synthetic-router-key")).toBe(true);
        expect(wires[0]?.path).toBe(route().replaceAll("${model}", encodeURIComponent(model)));
        const first = wires[0]!.body;
        if (format === "voyage.embeddings") {
          expect(first).toMatchObject({ input_type: "query", output_dimension: dimensions });
        }
        if (model.includes("cohere") || id === "cohere") {
          expect(first).toMatchObject({
            input_type: "search_query",
            truncate: id === "cohere" || !model.includes("v4") ? "END" : "RIGHT",
          });
          expect(wires.at(-1)?.body).toMatchObject({ input_type: "search_document" });
        }
        if (model.includes("marengo-2-7")) {
          expect(first).toEqual({ inputType: "text", inputText: "query" });
        }
        if (model.includes("marengo-3-0")) {
          expect(first).toEqual({ inputType: "text", text: { inputText: "query" } });
        }
        if (format.startsWith("google.")) {
          for (const wire of wires) {
            expect(wire.pathModel).toBe(kind === "manifest" ? model : undefined);
          }
          if (format === "google.batch_embed_contents") {
            expect(first).toMatchObject({ requests: [{ model: "models/" + model }] });
          }
        }
        if (model === "gemini-embedding-2" && format === "google.batch_embed_contents") {
          expect(first).toMatchObject({
            requests: [{ content: { parts: [{ text: "task: search result | query: query" }] } }],
          });
        }
        const measured = id !== "aws-bedrock" || model.includes("titan");
        expect(onUsage).toHaveBeenCalledWith(
          measured ? { promptTokens: 7, totalTokens: 7 } : undefined,
        );
      }
    },
  );
  it("aggregates qualified Google parts, preserves prepared text and rejects incomplete vectors", async () => {
    selected = cases[5];
    expect(
      resolveMemorySearchConfig(
        {
          ...options().config,
          memory: {
            search: {
              provider: "clawrouter",
              model: "google-gemini/gemini-embedding-2",
              fallback: "none",
              multimodal: { enabled: true, modalities: ["image"] },
            },
          },
        },
        "main",
      )?.multimodal?.enabled,
    ).toBe(true);
    routeKind = "manifest";
    const { provider } = await create(options());
    expect(
      await provider!.embed({
        text: "",
        parts: [
          { type: "text", text: "caption" },
          { type: "inline-data", mimeType: "image/png", data: "AA==" },
        ],
      }),
    ).toEqual(axis(128));
    expect(wires[0]?.body).toMatchObject({
      requests: [
        {
          content: {
            parts: [{ text: "caption" }, { inlineData: { mimeType: "image/png", data: "AA==" } }],
          },
        },
      ],
    });
    await provider!.embed("already prepared", {
      inputType: "query",
      queryInstructionApplied: true,
    });
    expect(wires.at(-1)?.body).toMatchObject({
      requests: [{ content: { parts: [{ text: "already prepared" }] } }],
    });
    invalidTail = true;
    await expect(provider!.embedBatch(["first", "second"])).rejects.toThrow("dimensions");
    eligible = false;
    const count = wires.length;
    await expect(provider!.embed("revoked")).rejects.toThrow("no eligible");
    expect(wires).toHaveLength(count);
  });
  it("rejects unqualified options and aborts before native dispatch; dimensions partition indexes", async () => {
    selected = cases[13];
    const cfg = options();
    expect(adapter().resolveIndexIdentity?.(cfg)).not.toEqual(
      adapter().resolveIndexIdentity?.({ ...cfg, dimensions: 512 }),
    );
    const { provider } = await create({ ...cfg, dimensions: 384 });
    await expect(provider!.embed("bad dimension")).rejects.toThrow("dimensions");
    const { provider: valid } = await create(cfg);
    await expect(
      valid!.embed({
        text: "",
        parts: [{ type: "inline-data", mimeType: "image/png", data: "AA==" }],
      }),
    ).rejects.toThrow("text-only");
    await expect(valid!.embed("cancel", { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(wires).toEqual([]);
  });
});
