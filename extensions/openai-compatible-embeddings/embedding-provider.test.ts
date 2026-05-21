import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { MemoryEmbeddingProviderCreateOptions } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenAICompatibleEmbeddingProvider } from "./embedding-provider.js";

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
};

type FixtureResponse = {
  object: "list";
  data: Array<{
    object?: "embedding";
    embedding: number[];
    index: number;
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
};

const servers: Array<{ close: () => Promise<void> }> = [];

function createOptions(
  overrides: Partial<MemoryEmbeddingProviderCreateOptions> = {},
): MemoryEmbeddingProviderCreateOptions {
  return {
    config: {} as MemoryEmbeddingProviderCreateOptions["config"],
    provider: "openai-compatible",
    model: "text-embedding-bge-m3",
    fallback: "none",
    ...overrides,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

async function startEmbeddingServer(params?: {
  token?: string;
  respond?: (request: CapturedRequest) => FixtureResponse | Record<string, unknown>;
  status?: number;
}): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readJsonBody(req);
      const captured: CapturedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      };
      requests.push(captured);

      if (params?.token) {
        expect(req.headers.authorization).toBe(`Bearer ${params.token}`);
      } else {
        expect(req.headers.authorization).toBeUndefined();
      }

      res.writeHead(params?.status ?? 200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          params?.respond?.(captured) ?? {
            object: "list",
            data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
            model: body.model,
          },
        ),
      );
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
  };
}

afterEach(async () => {
  const pending = servers.splice(0);
  await Promise.all(pending.map((server) => server.close()));
});

describe("openai-compatible embedding provider", () => {
  it("posts OpenAI-compatible embedding requests without warming up during create", async () => {
    const token = "local-test-token";
    const server = await startEmbeddingServer({
      token,
      respond: ({ body }) => {
        const input = body.input;
        const texts = Array.isArray(input) ? input : [input];
        return {
          object: "list",
          data: texts.map((text, index) => ({
            object: "embedding",
            embedding: [String(text).length, index + 0.25, 1],
            index,
          })),
          model: String(body.model),
          usage: { prompt_tokens: texts.length, total_tokens: texts.length },
        };
      },
    });

    const { provider, client } = await createOpenAICompatibleEmbeddingProvider(
      createOptions({
        model: "text-embedding-bge-m3",
        outputDimensionality: 1024,
        remote: {
          baseUrl: `  ${server.baseUrl}  `,
          apiKey: `  ${token}  `,
          headers: { "x-local-runtime": "ollama" },
        },
      }),
    );

    expect(provider.id).toBe("openai-compatible");
    expect(provider.model).toBe("text-embedding-bge-m3");
    expect(client.baseUrl).toBe(server.baseUrl);
    expect(client.headers.authorization).toBe(`Bearer ${token}`);
    expect(server.requests).toHaveLength(0);

    await expect(provider.embedQuery("hello")).resolves.toEqual([5, 0.25, 1]);
    await expect(provider.embedBatch(["a", "abcd"])).resolves.toEqual([
      [1, 0.25, 1],
      [4, 1.25, 1],
    ]);

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/embeddings",
      body: {
        model: "text-embedding-bge-m3",
        input: ["hello"],
        dimensions: 1024,
      },
    });
    expect(server.requests[0]?.body).not.toHaveProperty("encoding_format");
    expect(server.requests[0]?.headers["content-type"]).toContain("application/json");
    expect(server.requests[0]?.headers.accept).toBe("application/json");
    expect(server.requests[0]?.headers["x-local-runtime"]).toBe("ollama");
    expect(server.requests[1]?.body).toEqual({
      model: "text-embedding-bge-m3",
      input: ["a", "abcd"],
      dimensions: 1024,
    });
  });

  it("omits Authorization when no apiKey is configured", async () => {
    const server = await startEmbeddingServer();
    const { provider, client } = await createOpenAICompatibleEmbeddingProvider(
      createOptions({
        model: "nomic-embed-text",
        remote: { baseUrl: server.baseUrl },
      }),
    );

    expect(client.headers).not.toHaveProperty("authorization");

    await expect(provider.embedQuery("hello")).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });

  it.each([
    {
      runtime: "Ollama",
      response: {
        object: "list",
        data: [{ object: "embedding", embedding: [0.11, 0.12], index: 0 }],
        model: "nomic-embed-text",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      },
    },
    {
      runtime: "llama.cpp llama-server",
      response: {
        object: "list",
        data: [{ object: "embedding", embedding: [0.21, 0.22], index: 0 }],
        model: "bge-small-en-v1.5",
      },
    },
    {
      runtime: "vLLM",
      response: {
        object: "list",
        data: [{ object: "embedding", embedding: [0.31, 0.32], index: 0 }],
        model: "intfloat/e5-small-v2",
      },
    },
    {
      runtime: "LocalAI",
      response: {
        object: "list",
        data: [{ object: "embedding", embedding: [0.41, 0.42], index: 0 }],
        model: "text-embedding-ada-002",
      },
    },
    {
      runtime: "TGI-compatible server",
      response: {
        object: "list",
        data: [{ object: "embedding", embedding: [0.51, 0.52], index: 0 }],
        model: "tei-bge-small",
      },
    },
    {
      runtime: "llamafile",
      response: {
        object: "list",
        data: [{ object: "embedding", embedding: [0.61, 0.62], index: 0 }],
        model: "all-MiniLM-L6-v2",
      },
    },
  ] satisfies Array<{ runtime: string; response: FixtureResponse }>)(
    "parses $runtime OpenAI-compatible embedding responses through the same path",
    async ({ response }) => {
      const server = await startEmbeddingServer({ respond: () => response });
      const { provider } = await createOpenAICompatibleEmbeddingProvider(
        createOptions({
          model: response.model ?? "embedding-model",
          remote: { baseUrl: server.baseUrl },
        }),
      );

      await expect(provider.embedQuery("hello")).resolves.toEqual(response.data[0]?.embedding);
      expect(server.requests[0]?.url).toBe("/v1/embeddings");
      expect(server.requests[0]?.body).toEqual({
        model: response.model ?? "embedding-model",
        input: ["hello"],
      });
    },
  );

  it("reports missing required config with actionable keys", async () => {
    await expect(
      createOpenAICompatibleEmbeddingProvider(
        createOptions({ remote: { baseUrl: "   " }, model: "text-embedding-bge-m3" }),
      ),
    ).rejects.toThrow("embedding.baseUrl");
    await expect(
      createOpenAICompatibleEmbeddingProvider(
        createOptions({ remote: { baseUrl: "http://127.0.0.1:11434/v1" }, model: "   " }),
      ),
    ).rejects.toThrow("embedding.model");
  });

  it("keeps remote parser failures behind the provider-specific error prefix", async () => {
    const server = await startEmbeddingServer({ respond: () => ({ data: [] }) });
    const { provider } = await createOpenAICompatibleEmbeddingProvider(
      createOptions({
        model: "text-embedding-bge-m3",
        remote: { baseUrl: server.baseUrl },
      }),
    );

    await expect(provider.embedQuery("hello")).rejects.toThrow(
      "openai-compatible embeddings failed: malformed JSON response",
    );
  });
});
