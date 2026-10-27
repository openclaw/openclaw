import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { text as readText } from "node:stream/consumers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearEmbeddingProviders,
  listRegisteredEmbeddingProviders,
  restoreRegisteredEmbeddingProviders,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
import { createEmbeddingProvider, resolveEmbeddingProviderIndexIdentity } from "./embeddings.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
  rawBody: string;
};

type TestServer = {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
};

const servers: TestServer[] = [];
let registeredEmbeddingProvidersSnapshot: ReturnType<typeof listRegisteredEmbeddingProviders>;

async function startEmbeddingServer(options?: {
  reject?: (inputCount: number) => { status: number; body: unknown } | undefined;
  authorization?: string;
}): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    void (async () => {
      try {
        const rawBody = await readText(req);
        const body = JSON.parse(rawBody) as Record<string, unknown>;
        requests.push({ method: req.method, url: req.url, headers: req.headers, body, rawBody });
        if (options?.authorization && req.headers.authorization !== options.authorization) {
          respond(401, { error: { message: "Invalid fixture credential" } });
          return;
        }
        const input = body.input;
        const texts = Array.isArray(input) ? input : [input];
        const rejection = options?.reject?.(texts.length);
        if (rejection) {
          respond(rejection.status, rejection.body);
          return;
        }
        respond(200, {
          data: texts.map((text, index) => ({
            embedding: [String(text).length, index + 0.5, 3],
            index,
          })),
        });
      } catch (error) {
        respond(500, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  const port = await listenOnLoopback(server);
  const testServer = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  servers.push(testServer);
  return testServer;
}

function createQianfanConfig(baseUrl: string): OpenClawConfig {
  return {
    plugins: { allow: ["qianfan"], entries: { qianfan: { enabled: true } } },
    models: {
      providers: {
        qianfan: { api: "openai-completions", baseUrl, models: [] },
      },
    },
  };
}

function createMemoryEmbeddingOptions(overrides?: {
  provider?: string;
  model?: string;
  baseUrl?: string;
  outputDimensionality?: number;
}) {
  return {
    config: { plugins: { enabled: false } } as OpenClawConfig,
    agentDir: "/tmp/openclaw-agent",
    provider: overrides?.provider ?? "openai-compatible",
    fallback: "none",
    model: overrides?.model ?? "text-embedding-bge-m3",
    inputType: "default",
    queryInputType: "query",
    documentInputType: "document",
    remote: {
      baseUrl: overrides?.baseUrl,
      apiKey: "fixture-token",
      headers: {
        Authorization: "Bearer destination-header",
        "x-api-key": "hidden",
        "x-deployment": "tenant-a",
      },
    },
    outputDimensionality: overrides?.outputDimensionality ?? 3,
  };
}

beforeEach(() => {
  registeredEmbeddingProvidersSnapshot = listRegisteredEmbeddingProviders();
  clearEmbeddingProviders();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const pendingServers = servers.splice(0);
  await Promise.all(pendingServers.map((server) => server.close()));
  restoreRegisteredEmbeddingProviders(registeredEmbeddingProvidersSnapshot);
});

describe("memory-core generic embedding provider contract", () => {
  it("uses the core OpenAI-compatible provider through the generic registry", async () => {
    const server = await startEmbeddingServer();

    expect(listRegisteredEmbeddingProviders()).toMatchObject([
      {
        ownerPluginId: "core",
        adapter: { id: "openai-compatible" },
      },
    ]);

    const result = await createEmbeddingProvider(
      createMemoryEmbeddingOptions({ baseUrl: `  ${server.baseUrl}/  ` }),
    );

    expect(result.provider?.id).toBe("openai-compatible");
    expect(result.provider?.model).toBe("text-embedding-bge-m3");
    expect(result.runtime).toMatchObject({
      id: "openai-compatible",
      inlineBatchTimeoutMs: 600_000,
      cacheKeyData: {
        provider: "openai-compatible",
        baseUrl: server.baseUrl,
        model: "text-embedding-bge-m3",
        dimensions: 3,
        inputType: "default",
        queryInputType: "query",
        documentInputType: "document",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-deployment": "tenant-a",
        },
      },
    });
    expect(server.requests).toHaveLength(0);

    await expect(result.provider?.embed("hello", { inputType: "query" })).resolves.toEqual([
      5, 0.5, 3,
    ]);
    await expect(
      result.provider?.embedBatch(["a", "abcd"], { inputType: "document" }),
    ).resolves.toEqual([
      [1, 0.5, 3],
      [4, 1.5, 3],
    ]);
    await expect(
      result.provider?.embedBatch(
        [
          {
            text: "structured doc",
            parts: [{ type: "text", text: "structured doc" }],
          },
        ],
        { inputType: "document" },
      ),
    ).resolves.toEqual([[14, 0.5, 3]]);

    expect(server.requests).toHaveLength(3);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/embeddings",
      body: {
        model: "text-embedding-bge-m3",
        input: ["hello"],
        dimensions: 3,
        input_type: "query",
      },
    });
    expect(server.requests[0]?.body).not.toHaveProperty("encoding_format");
    expect(server.requests[0]?.headers.authorization).toBe("Bearer destination-header");
    expect(server.requests[0]?.headers["x-api-key"]).toBe("hidden");
    expect(server.requests[0]?.headers["x-deployment"]).toBe("tenant-a");
    expect(server.requests[1]?.body).toEqual({
      model: "text-embedding-bge-m3",
      input: ["a", "abcd"],
      dimensions: 3,
      input_type: "document",
    });
    expect(server.requests[2]?.body).toEqual({
      model: "text-embedding-bge-m3",
      input: ["structured doc"],
      dimensions: 3,
      input_type: "document",
    });
  });

  it("does not make generic embedding providers memory auto-selection candidates", async () => {
    const server = await startEmbeddingServer();

    await expect(
      createEmbeddingProvider(
        createMemoryEmbeddingOptions({
          provider: "auto",
          baseUrl: server.baseUrl,
        }),
      ),
    ).rejects.toThrow("Unknown memory embedding provider: openai");
    expect(server.requests).toHaveLength(0);
  });
});

// Keep batching, splitting, retry classification, and timeout ownership real.
type EmbeddingOverrides = Partial<
  Pick<
    Parameters<typeof createEmbeddingProvider>[0],
    "provider" | "model" | "config" | "outputDimensionality"
  >
>;

async function createMemoryEmbeddingOwnerForServer(
  baseUrl: string,
  overrides?: EmbeddingOverrides,
) {
  const options = {
    config: { plugins: { enabled: false } },
    agentDir: "/tmp/openclaw-agent",
    provider: "openai-compatible",
    fallback: "none",
    model: "text-embedding-bge-m3",
    remote: { baseUrl, apiKey: "fixture-token" },
    outputDimensionality: 3,
    ...overrides,
  };
  const created = await createEmbeddingProvider(options);
  const provider = created.provider;
  if (!provider) {
    throw new Error("expected the OpenAI-compatible embedding provider to be created");
  }
  // Index/cache mapping is covered by index.test.ts; keep the real retry/HTTP boundary here.
  const owner = Object.assign(Object.create(MemoryManagerEmbeddingOps.prototype), {
    provider,
    providerRuntime: created.runtime,
    settings: {},
    markLocalEmbeddingProviderDegraded: () => {},
  }) as {
    settings: { queryInstruction?: string; inputFormat?: { query: string; document: string } };
    embedQueryWithRetry: (text: string) => Promise<number[]>;
    embedBatchWithRetry: (texts: string[]) => Promise<number[][]>;
  };
  return { owner, provider, runtime: created.runtime, options };
}

const distinctInputs = (count: number) =>
  Array.from({ length: count }, (_, index) => "x".repeat(index + 1));

async function expectBatchEmbedding(
  server: TestServer,
  owner: Awaited<ReturnType<typeof createMemoryEmbeddingOwnerForServer>>["owner"],
  count: number,
  limit: number,
  requests: number[],
) {
  const embeddings = await owner.embedBatchWithRetry(distinctInputs(count));
  expect(server.requests.map(({ body }) => (body.input as unknown[]).length)).toEqual(requests);
  expect(embeddings).toEqual(
    Array.from({ length: count }, (_, index) => [index + 1, (index % limit) + 0.5, 3]),
  );
}

describe("memory query instructions over real transport", () => {
  it.each([
    { model: "nvidia/Nemotron-3-Embed-8B-BF16" },
    { model: "hf.co/maternion/Nemotron-3.5-Embed-8B-GGUF:Q8_0" },
    { model: "generic-embedding-alias", inputFormat: { query: "query: ", document: "passage: " } },
  ])("formats both retrieval roles for $model", async ({ model, inputFormat }) => {
    const server = await startEmbeddingServer();
    const { owner } = await createMemoryEmbeddingOwnerForServer(server.baseUrl, {
      model,
    });
    owner.settings.inputFormat = inputFormat;
    const documents = await owner.embedBatchWithRetry(["remember this"]);
    await owner.embedQueryWithRetry("find this");
    owner.settings.queryInstruction = "custom: ";
    await expect(owner.embedQueryWithRetry("find this")).resolves.toEqual([17, 0.5, 3]);
    expect(await owner.embedBatchWithRetry(["remember this"])).toEqual(documents);
    expect(server.requests[0]?.rawBody).toBe(server.requests[3]?.rawBody);
    expect(server.requests.map(({ body }) => body.input)).toEqual([
      ["passage: remember this"],
      ["query: find this"],
      ["custom: find this"],
      ["passage: remember this"],
    ]);
  });

  it("keeps other Nemotron families raw and supports explicit empty prefixes", async () => {
    const server = await startEmbeddingServer();
    const { owner } = await createMemoryEmbeddingOwnerForServer(server.baseUrl, {
      model: "nvidia/llama-embed-nemotron-8b",
    });
    await owner.embedBatchWithRetry(["remember this"]);
    await owner.embedQueryWithRetry("find this");
    owner.settings.queryInstruction = "custom: ";
    await owner.embedQueryWithRetry("find this");
    owner.settings.queryInstruction = "";
    owner.settings.inputFormat = { query: "", document: "" };
    await owner.embedBatchWithRetry(["remember this"]);
    await owner.embedQueryWithRetry("find this");
    expect(server.requests[0]?.rawBody).toBe(server.requests[3]?.rawBody);
    expect(server.requests[1]?.rawBody).toBe(server.requests[4]?.rawBody);
    expect(server.requests.slice(0, 2).map(({ body }) => body.input)).toEqual([
      ["remember this"],
      ["find this"],
    ]);
  });
});

describe("memory-core embedding batch recovery over real transport", () => {
  it.each<[model: string, limit: number, requests: number[], resolvedModel?: string]>([
    ["qianfan/bge-large-en", 16, [16, 16, 1], "bge-large-en"],
    ["Embedding-V1", 16, [16, 16, 1]],
    ["custom-embedding-model", 33, [33]],
  ])(
    "batches 33 inputs using Qianfan's documented cap for %s",
    async (model, limit, requests, resolvedModel) => {
      const server = await startEmbeddingServer({
        reject: (count) =>
          count > limit
            ? {
                status: 400,
                body: { error: { message: "batch exceeds fixture limit" } },
              }
            : undefined,
      });
      const { owner, provider, runtime, options } = await createMemoryEmbeddingOwnerForServer(
        server.baseUrl,
        {
          provider: "qianfan",
          model,
          config: createQianfanConfig(server.baseUrl),
        },
      );
      expect(provider.id).toBe("qianfan");
      expect(runtime?.id).toBe("qianfan");
      expect(resolveEmbeddingProviderIndexIdentity(options)?.provider).toEqual({
        id: "qianfan",
        model: resolvedModel ?? model,
      });

      await expectBatchEmbedding(server, owner, 33, limit, requests);
    },
  );

  it.each([
    { name: "environment", envKey: "fixture-env-key", expected: "fixture-env-key" },
    { name: "saved profile", expected: "fixture-profile-key" },
    { name: "remote API key", apiKey: "fixture-remote-key", expected: "fixture-remote-key" },
    { name: "remote header", header: "Bearer fixture-header-key", expected: "fixture-header-key" },
  ])("uses Qianfan $name credentials over HTTP", async ({ envKey, apiKey, header, expected }) => {
    await withOpenClawTestState({ label: "qianfan-embedding-auth" }, async (state) => {
      vi.stubEnv("QIANFAN_API_KEY", envKey);
      await state.writeAuthProfiles({
        version: 1,
        profiles: envKey
          ? {}
          : {
              "qianfan:default": {
                type: "api_key",
                provider: "qianfan",
                key: "fixture-profile-key",
              },
            },
      });
      const server = await startEmbeddingServer({ authorization: `Bearer ${expected}` });
      const result = await createEmbeddingProvider({
        config: createQianfanConfig(server.baseUrl),
        agentDir: state.agentDir(),
        provider: "qianfan",
        fallback: "none",
        model: "bge-large-zh",
        remote: { apiKey, headers: header ? { Authorization: header } : undefined },
      });
      await expect(result.provider?.embed("hello")).resolves.toEqual([5, 0.5, 3]);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${expected}`);
    });
  });

  it("does not send Qianfan credentials to a different remote destination", async () => {
    await withOpenClawTestState({ label: "qianfan-embedding-destination" }, async (state) => {
      vi.stubEnv("QIANFAN_API_KEY", "fixture-env-key");
      const providerServer = await startEmbeddingServer();
      const remoteServer = await startEmbeddingServer();
      await expect(
        createEmbeddingProvider({
          config: createQianfanConfig(providerServer.baseUrl),
          agentDir: state.agentDir(),
          provider: "qianfan",
          fallback: "none",
          model: "bge-large-zh",
          remote: { baseUrl: remoteServer.baseUrl },
        }),
      ).rejects.toThrow("embedding credentials are not configured");
      expect(remoteServer.requests).toEqual([]);
    });
  });

  // Declared and corrected caps are covered by the paired-input policy tests.
  it("halves a rejected HTTP batch when the endpoint gives no numeric cap", async () => {
    const server = await startEmbeddingServer({
      reject: (count) =>
        count > 50
          ? {
              status: 400,
              body: { error: { message: "request header fields too large" } },
            }
          : undefined,
    });
    const { owner } = await createMemoryEmbeddingOwnerForServer(server.baseUrl);
    await expectBatchEmbedding(server, owner, 100, 50, [100, 50, 50]);
  });

  it("does not split a terminal provider rejection", async () => {
    const server = await startEmbeddingServer({
      reject: () => ({
        status: 400,
        body: {
          error: { code: "1214", message: "input array must contain strings" },
        },
      }),
    });
    const { owner } = await createMemoryEmbeddingOwnerForServer(server.baseUrl);
    await expect(owner.embedBatchWithRetry(distinctInputs(100))).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_OPERATION_FAILED",
      operation: "batch",
    });
    expect(server.requests).toHaveLength(1);
  });

  it("does not retry or split when the endpoint ignores requested dimensions", async () => {
    // The fixture server always answers with three dimensions.
    const server = await startEmbeddingServer();
    const { owner } = await createMemoryEmbeddingOwnerForServer(server.baseUrl, {
      outputDimensionality: 2,
    });
    await expect(owner.embedBatchWithRetry(distinctInputs(4))).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_OPERATION_FAILED",
      operation: "batch",
      message: expect.stringContaining(
        "expected 2 dimensions, got 3 at index 0; the endpoint did not honor the requested dimensions",
      ),
    });
    expect(server.requests.map((request) => request.body.dimensions)).toEqual([2]);
  });
});
