import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { json } from "node:stream/consumers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearEmbeddingProviders,
  listRegisteredEmbeddingProviders,
  restoreRegisteredEmbeddingProviders,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createEmbeddingProvider } from "./embeddings.js";
import type { IndexedMemoryChunk } from "./manager-chunk-writer.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";
import type { MemoryIndexWorkItem, MemorySemanticProviderGeneration } from "./manager-sync-ops.js";

type CapturedRequest = Pick<IncomingMessage, "method" | "url" | "headers"> & {
  body: Record<string, unknown>;
};

type TestServer = {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
};

const servers: TestServer[] = [];
const providerId = "openai-compatible";
const model = "text-embedding-bge-m3";
let registeredEmbeddingProvidersSnapshot: ReturnType<typeof listRegisteredEmbeddingProviders>;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startEmbeddingServer(
  rejectRequest?: (inputCount: number) => { message: string; code?: string } | undefined,
): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (req, res) => {
    try {
      const body = (await json(req)) as Record<string, unknown>;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const input = body.input;
      const texts = Array.isArray(input) ? input : [input];
      const rejection = rejectRequest?.(texts.length);
      if (rejection) {
        sendJson(res, 400, { error: rejection });
        return;
      }
      sendJson(res, 200, {
        data: texts.map((text, index) => ({
          embedding: [String(text).length, index + 0.5, 3],
          index,
        })),
      });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const testServer = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  servers.push(testServer);
  return testServer;
}

function createMemoryEmbeddingOptions(baseUrl: string, provider = providerId) {
  return {
    config: { plugins: { enabled: false } } satisfies OpenClawConfig,
    agentDir: "/tmp/openclaw-agent",
    provider,
    fallback: "none",
    model,
    inputType: "default",
    queryInputType: "query",
    documentInputType: "document",
    remote: {
      baseUrl,
      apiKey: "fixture-token",
      headers: {
        Authorization: "Bearer destination-header",
        "x-api-key": "hidden",
        "x-deployment": "tenant-a",
      },
    },
    outputDimensionality: 3,
  };
}

beforeEach(() => {
  registeredEmbeddingProvidersSnapshot = listRegisteredEmbeddingProviders();
  clearEmbeddingProviders();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  restoreRegisteredEmbeddingProviders(registeredEmbeddingProvidersSnapshot);
});

it("uses the core OpenAI-compatible provider through the generic registry", async () => {
  const server = await startEmbeddingServer();
  const requestBody = (input: string[], input_type: string) => ({
    model,
    input,
    dimensions: 3,
    input_type,
  });

  expect(listRegisteredEmbeddingProviders()).toMatchObject([
    { ownerPluginId: "core", adapter: { id: providerId } },
  ]);

  const result = await createEmbeddingProvider(
    createMemoryEmbeddingOptions(`  ${server.baseUrl}/  `),
  );

  expect(result.provider).toMatchObject({ id: providerId, model });
  expect(result.runtime).toMatchObject({
    id: providerId,
    inlineBatchTimeoutMs: 600_000,
    cacheKeyData: {
      provider: providerId,
      baseUrl: server.baseUrl,
      model,
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
  const textPart = { type: "text" as const, text: "structured doc" };
  const doc = { text: textPart.text, parts: [textPart] };
  await expect(result.provider?.embedBatch([doc], { inputType: "document" })).resolves.toEqual([
    [14, 0.5, 3],
  ]);

  expect(server.requests).toHaveLength(3);
  expect(server.requests[0]).toMatchObject({
    method: "POST",
    url: "/v1/embeddings",
    body: requestBody(["hello"], "query"),
    headers: {
      authorization: "Bearer destination-header",
      "x-api-key": "hidden",
      "x-deployment": "tenant-a",
    },
  });
  expect(server.requests[0]?.body).not.toHaveProperty("encoding_format");
  expect(server.requests[1]?.body).toEqual(requestBody(["a", "abcd"], "document"));
  expect(server.requests[2]?.body).toEqual(requestBody(["structured doc"], "document"));
});

it("does not make generic embedding providers memory auto-selection candidates", async () => {
  const server = await startEmbeddingServer();

  await expect(
    createEmbeddingProvider(createMemoryEmbeddingOptions(server.baseUrl, "auto")),
  ).rejects.toThrow("Unknown memory embedding provider: openai");
  expect(server.requests).toHaveLength(0);
});
async function createMemoryEmbeddingOwnerForServer(baseUrl: string, database: DatabaseSync) {
  const created = await createEmbeddingProvider(createMemoryEmbeddingOptions(baseUrl));
  const provider = created.provider;
  if (!provider) {
    throw new Error("expected the OpenAI-compatible embedding provider to be created");
  }
  const generation: MemorySemanticProviderGeneration = {
    kind: "semantic",
    provider,
    runtime: created.runtime,
    database: new MemoryIndexDatabase(database),
    cacheWritesInvalidated: false,
    providerKey: "integration-proof",
    identities: [],
  };
  const owner = Object.assign(Object.create(MemoryManagerEmbeddingOps.prototype), {
    provider,
    providerRuntime: generation.runtime,
    publishedDatabase: generation.database,
    syncProviderGeneration: generation,
    cache: { enabled: false },
    settings: { sync: {} },
    markLocalEmbeddingProviderDegraded: () => {},
  }) as {
    embedChunksInBatches: (
      candidates: ReturnType<typeof distinctCandidates>,
      generation: MemorySemanticProviderGeneration,
      maxTokens: number,
    ) => Promise<number[][]>;
  };
  return {
    provider,
    embed: (count: number) =>
      owner.embedChunksInBatches(distinctCandidates(count), generation, 8000),
  };
}

// Unique text lengths make each vector identify its own input, because the
// fixture server answers with `[text.length, indexWithinRequest + 0.5, 3]`.
function distinctCandidates(
  count: number,
): Array<MemoryIndexWorkItem & { chunk: IndexedMemoryChunk }> {
  return Array.from({ length: count }, (_, index) => ({
    chunk: {
      text: "x".repeat(index + 1),
      hash: `hash-${index}`,
      startLine: index + 1,
      endLine: index + 1,
      importance: null,
      triggers: null,
      projectKey: null,
    },
    entry: {
      path: `memory/chunk-${index}.md`,
      absPath: `/fixture/memory/chunk-${index}.md`,
      mtimeMs: 0,
      size: index + 1,
      hash: `hash-${index}`,
    },
    source: "memory",
  }));
}

it.each([
  limitCase("input array max 10", 33, 10, [10, 10, 10, 3], 10),
  limitCase("input array max 10", 33, 10, [20, 10, 10, 13, 10, 3], 20),
  limitCase("batch size is invalid, it should not be larger than 10", 33, 10, [33, 10, 10, 10, 3]),
  limitCase("input array max 64", 100, 64, [100, 64, 36]),
  limitCase("input数组最大不得超过10条", 33, 10, [33, 10, 10, 10, 3]),
  limitCase("Embeddings API input limit exceeded: max 10, got 33", 33, 10, [33, 10, 10, 10, 3]),
  limitCase("request header fields too large", 100, 50, [100, 50, 50]),
])(
  "embeds in order for $message with declared cap $maxInputsPerRequest",
  async ({ message, count, limit, requests, maxInputsPerRequest }) => {
    const server = await startEmbeddingServer((inputCount) =>
      inputCount > limit ? { message } : undefined,
    );
    using database = new DatabaseSync(":memory:");
    const { provider, embed } = await createMemoryEmbeddingOwnerForServer(server.baseUrl, database);
    provider.maxInputsPerRequest = maxInputsPerRequest;
    const embeddings = await embed(count);

    expect(server.requests.map((request) => (request.body.input as unknown[]).length)).toEqual(
      requests,
    );
    expect(embeddings).toEqual(
      Array.from({ length: count }, (_, index) => [index + 1, (index % limit) + 0.5, 3]),
    );
  },
);

it.each([
  "input array must contain strings",
  "input array item max length 64",
  "input array max 64 tokens",
  "input array max 64tokens",
  "input array max 64.5",
])("does not split a terminal provider rejection: %s", async (message) => {
  const server = await startEmbeddingServer(() => ({ code: "1214", message }));
  using database = new DatabaseSync(":memory:");
  const { embed } = await createMemoryEmbeddingOwnerForServer(server.baseUrl, database);
  await expect(embed(100)).rejects.toMatchObject({
    code: "MEMORY_EMBEDDING_OPERATION_FAILED",
    operation: "batch",
  });
  expect(server.requests).toHaveLength(1);
});
function limitCase(
  message: string,
  count: number,
  limit: number,
  requests: number[],
  maxInputsPerRequest?: number,
) {
  return { message, count, limit, requests, maxInputsPerRequest };
}
