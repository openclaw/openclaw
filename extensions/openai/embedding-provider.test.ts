// Exercise the provider, shared factory, and guarded HTTP transport together.
import { once } from "node:events";
import fs from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import type { MemoryEmbeddingProviderCreateOptions } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { updateAuthProfileStoreWithLock } from "openclaw/plugin-sdk/provider-auth";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiEmbeddingProvider } from "./embedding-provider.js";

type EmbeddingBody = {
  model: string;
  input: string[];
  dimensions?: number;
  input_type?: string;
};
type CapturedRequest = {
  url: string | undefined;
  authorization: string | undefined;
  alias: string | string[] | undefined;
  body: EmbeddingBody;
  response: ServerResponse;
  closed: boolean;
};

const servers: Server[] = [];

function respondWithEmbeddings(request: CapturedRequest): void {
  request.response.writeHead(200, { "content-type": "application/json" });
  request.response.end(
    JSON.stringify({
      data: request.body.input
        .map((text, index) => ({ index, embedding: [text.length, index + 1] }))
        .toReversed(),
    }),
  );
}

async function startEmbeddingServer(onRequest = respondWithEmbeddings) {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const captured: CapturedRequest = {
          url: request.url,
          authorization: request.headers.authorization,
          alias: request.headers["x-alias"],
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as EmbeddingBody,
          response,
          closed: false,
        };
        response.once("close", () => {
          captured.closed = true;
        });
        requests.push(captured);
        onRequest(captured);
      } catch (error) {
        response.writeHead(500).end(String(error));
      }
    })();
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}/tenant/v1`, requests };
}

function createOptions(
  overrides: Partial<MemoryEmbeddingProviderCreateOptions> = {},
): MemoryEmbeddingProviderCreateOptions {
  return {
    config: {},
    provider: "openai",
    model: "text-embedding-3-small",
    fallback: "none",
    ...overrides,
    remote: { apiKey: "fixture-openai-key", ...overrides.remote },
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

describe("OpenAI embedding provider HTTP contract", () => {
  it.each([
    { additional: "none", custom: false, binding: undefined },
    { additional: "token", custom: false, binding: undefined },
    { additional: "api-key", custom: false, binding: undefined },
    { additional: "token", custom: true, binding: undefined },
  ])(
    "selects compatible embedding auth with SIWC and $additional (custom=$custom, binding=$binding)",
    async ({ additional, custom, binding }) => {
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-embedding-auth-"));
      vi.stubEnv("OPENAI_API_KEY", "");
      try {
        const server = custom ? await startEmbeddingServer() : undefined;
        await expect(
          updateAuthProfileStoreWithLock({
            agentDir,
            saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
            updater(store) {
              store.profiles = {
                "openai:siwc": {
                  type: "oauth",
                  provider: "openai",
                  authFlow: "chatgpt-token-sharing",
                  access: "fixture-siwc-access",
                  refresh: "fixture-siwc-refresh",
                  expires: Date.now() + 3_600_000,
                },
                ...(additional === "api-key"
                  ? {
                      "openai:api": {
                        type: "api_key" as const,
                        provider: "openai",
                        key: "fixture-embedding-api-key",
                      },
                    }
                  : additional === "token"
                    ? {
                        "openai:api": {
                          type: "token" as const,
                          provider: "openai",
                          token: "fixture-embedding-token",
                        },
                      }
                    : {}),
              };
              return true;
            },
          }),
        ).resolves.not.toBeNull();
        const result = createOpenAiEmbeddingProvider(
          createOptions({
            agentDir,
            config: {
              auth: { order: { openai: ["openai:siwc", "openai:api"] } },
              ...(server
                ? {
                    models: {
                      providers: {
                        openai: { baseUrl: server.baseUrl, apiKey: binding, models: [] },
                      },
                    },
                  }
                : {}),
            },
            remote: { apiKey: undefined },
          }),
        );
        if (additional === "api-key") {
          await expect(result).resolves.toMatchObject({
            provider: { maxInputsPerRequest: 2048 },
            client: { headers: { Authorization: "Bearer fixture-embedding-api-key" } },
          });
        } else if (server && additional === "token") {
          const { provider } = await result;
          await expect(provider.embed("hello")).resolves.toEqual([5, 1]);
          expect(server.requests).toHaveLength(1);
          expect(server.requests[0]).toMatchObject({
            url: "/tenant/v1/embeddings",
            authorization: "Bearer fixture-embedding-token",
            body: { model: "text-embedding-3-small", input: ["hello"] },
          });
        } else {
          await expect(result).rejects.toThrow('No API key found for provider "openai"');
          expect(server?.requests ?? []).toHaveLength(0);
        }
      } finally {
        clearRuntimeAuthProfileStoreSnapshots();
        await closeOpenClawAgentDatabasesAsync();
        fs.rmSync(agentDir, { recursive: true, force: true });
        vi.unstubAllEnvs();
      }
    },
  );

  it("uses the newly stored OAuth bearer on the next embedding request after re-login", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-embedding-relogin-"));
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_OAUTH_TOKEN", "");
    const publishBearer = async (access: string) => {
      await expect(
        updateAuthProfileStoreWithLock({
          agentDir,
          saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
          updater(store) {
            store.profiles["openai:embedding"] = {
              type: "oauth",
              provider: "openai",
              access,
              refresh: "fixture-refresh",
              expires: Date.now() + 3_600_000,
            };
            return true;
          },
        }),
      ).resolves.not.toBeNull();
    };
    try {
      const server = await startEmbeddingServer();
      await publishBearer("fixture-before-login");
      const { provider, client } = await createOpenAiEmbeddingProvider(
        createOptions({
          agentDir,
          config: {
            auth: { order: { openai: ["openai:embedding"] } },
            models: { providers: { openai: { baseUrl: server.baseUrl, models: [] } } },
          },
          remote: { apiKey: undefined },
        }),
      );
      await expect(provider.embed("first")).resolves.toEqual([5, 1]);
      await publishBearer("fixture-after-login");
      await expect(provider.embedBatch(["second"])).resolves.toEqual([[6, 1]]);
      expect(server.requests.map((request) => request.authorization)).toEqual([
        "Bearer fixture-before-login",
        "Bearer fixture-after-login",
      ]);
      expect(client.headers).not.toHaveProperty("Authorization");
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await closeOpenClawAgentDatabasesAsync();
      fs.rmSync(agentDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it("reads mutable client payload fields per call while retaining endpoint and provider metadata", async () => {
    const server = await startEmbeddingServer();
    const { provider, client } = await createOpenAiEmbeddingProvider(
      createOptions({ queryInputType: "query", remote: { baseUrl: server.baseUrl } }),
    );
    await provider.embed("first", { inputType: "query" });
    client.model = "updated-model";
    client.queryInputType = " updated-query ";
    client.outputDimensionality = 64;
    client.headers = { ...client.headers, "x-alias": "updated" };
    client.baseUrl = `${server.baseUrl}/unused`;

    await provider.embed("second", { inputType: "query" });

    expect(provider.model).toBe("text-embedding-3-small");
    expect(provider.maxInputTokens).toBe(8192);
    expect(server.requests.map(({ url, alias, body }) => ({ url, alias, body }))).toEqual([
      {
        url: "/tenant/v1/embeddings",
        alias: undefined,
        body: { model: "text-embedding-3-small", input: ["first"], input_type: "query" },
      },
      {
        url: "/tenant/v1/embeddings",
        alias: "updated",
        body: {
          model: "updated-model",
          input: ["second"],
          dimensions: 64,
          input_type: "updated-query",
        },
      },
    ]);
  });

  it("starts query requests concurrently and preserves input order despite reversed completion", async () => {
    const server = await startEmbeddingServer(() => {});
    const controller = new AbortController();
    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({ queryInputType: "query", remote: { baseUrl: server.baseUrl } }),
    );
    const outcome = provider
      .embedBatch(["first", { text: "second" }], {
        inputType: "query",
        signal: controller.signal,
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    try {
      // Both requests must reach HTTP before either response is released.
      await vi.waitFor(() => expect(server.requests).toHaveLength(2));
      const first = server.requests.find((request) => request.body.input[0] === "first");
      const second = server.requests.find((request) => request.body.input[0] === "second");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) {
        throw new Error("missing query request");
      }
      expect(server.requests.map((request) => request.body.input_type)).toEqual(["query", "query"]);
      respondWithEmbeddings(second);
      await vi.waitFor(() => expect(second.closed).toBe(true));
      respondWithEmbeddings(first);
      await expect(outcome).resolves.toEqual({
        value: [
          [5, 1],
          [6, 1],
        ],
      });
    } finally {
      controller.abort();
      await outcome;
    }
  });

  it.each(["cancel", "first request failure"] as const)(
    "preserves query-batch %s and releases every guarded request",
    async (mode) => {
      const server = await startEmbeddingServer(() => {});
      const controller = new AbortController();
      const { provider } = await createOpenAiEmbeddingProvider(
        createOptions({ remote: { baseUrl: server.baseUrl } }),
      );
      const outcome = provider
        .embedBatch(["first", "second"], { inputType: "query", signal: controller.signal })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      try {
        await vi.waitFor(() => expect(server.requests).toHaveLength(2));
        if (mode === "first request failure") {
          server.requests[0]?.response.writeHead(503).end("fixture rejected");
          await expect(outcome).resolves.toMatchObject({
            error: {
              name: "ProviderHttpError",
              status: 503,
              message:
                "openai embeddings failed (model: text-embedding-3-small, batch size: 1) (503): fixture rejected",
            },
          });
          // Promise.all rejects early; it must not cancel the still-running sibling.
          expect(server.requests[1]?.closed).toBe(false);
        }
        controller.abort(new Error("fixture caller cancellation"));
        await expect(outcome).resolves.toHaveProperty("error");
        await vi.waitFor(() =>
          expect(server.requests.every((request) => request.closed)).toBe(true),
        );
        expect(server.requests).toHaveLength(2);
      } finally {
        controller.abort();
        await outcome;
      }
    },
  );

  it("preserves qualified router models in metadata and request bodies", async () => {
    const server = await startEmbeddingServer();
    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({
        model: "openai/text-embedding-3-small",
        remote: { baseUrl: server.baseUrl },
      }),
    );
    expect(provider.model).toBe("openai/text-embedding-3-small");
    expect(provider.maxInputsPerRequest).toBeUndefined();
    expect(provider.maxInputTokens).toBe(8192);
    await provider.embed("hello", { inputType: "query" });
    expect(server.requests[0]?.body.model).toBe("openai/text-embedding-3-small");
  });

  it("defaults the client provider lookup to OpenAI", async () => {
    const { client } = await createOpenAiEmbeddingProvider(createOptions({ provider: undefined }));
    expect(client.baseUrl).toBe("https://api.openai.com/v1");
    expect(client.model).toBe("text-embedding-3-small");
  });
});
