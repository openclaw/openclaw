import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { MemoryEmbeddingProviderCreateOptions } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { describe, expect, it, onTestFinished } from "vitest";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";
import { mistralMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

function createOptions(
  remote: MemoryEmbeddingProviderCreateOptions["remote"] = {},
  config: MemoryEmbeddingProviderCreateOptions["config"] = {},
): MemoryEmbeddingProviderCreateOptions {
  return {
    config,
    provider: "mistral",
    model: "mistral-embed",
    fallback: "none",
    remote: { apiKey: "fixture-mistral-key-before", ...remote },
  };
}

async function identity(...params: Parameters<typeof createOptions>) {
  return (await mistralMemoryEmbeddingProviderAdapter.create(createOptions(...params))).runtime
    ?.cacheKeyData;
}

async function outboundHeaders(...params: Parameters<typeof createOptions>) {
  let headers: IncomingHttpHeaders = {};
  const server = createServer((request, response) => {
    headers = request.headers;
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }));
  });
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const port = await listenOnLoopback(server);
  const options = createOptions(...params);
  const { provider } = await mistralMemoryEmbeddingProviderAdapter.create({
    ...options,
    remote: { ...options.remote, baseUrl: `http://127.0.0.1:${port}/v1` },
  });
  assert(provider, "expected configured Mistral embedding provider");
  await expect(provider.embed("fixture input")).resolves.toEqual([1, 2]);
  return headers;
}

describe("Mistral memory embedding index identity", () => {
  it.each([undefined, "https://API.MISTRAL.AI:443/v1/"])(
    "keeps default identity for %s",
    async (baseUrl) => {
      const key = await identity({ baseUrl });
      expect(key).toEqual({ provider: "mistral", model: "mistral-embed" });
    },
  );

  it("partitions endpoints and tenants without including rotated authentication headers", async () => {
    const endpoint = "https://mistral-region-a.example.test/v1";
    const tenantHeaders = { "X-Tenant": "tenant-a", "X-Deployment": "deployment-a" };
    const routingHeaders = {
      ...tenantHeaders,
      "User-Agent": "tenant-router/1",
      version: "tenant-api-v1",
    };
    const headers = {
      ...routingHeaders,
      "X-Api-Key": "fixture-proxy-key-before",
      "api-key": "fixture-azure-key-before",
    };
    const firstParams = { baseUrl: endpoint, headers };
    const first = await identity(firstParams);
    const rotated = await identity({
      baseUrl: endpoint,
      apiKey: "fixture-mistral-key-after",
      headers: {
        version: "tenant-api-v1",
        "User-Agent": "tenant-router/1",
        "Api-Key": "fixture-azure-key-after",
        "x-aPI-kEY": "fixture-proxy-key-after",
        "X-Deployment": "deployment-a",
        "X-Tenant": "tenant-a",
      },
    });
    expect(await outboundHeaders(firstParams)).toMatchObject(
      Object.fromEntries(
        Object.entries({ Authorization: "Bearer fixture-mistral-key-before", ...headers }).map(
          ([name, value]) => [name.toLowerCase(), value],
        ),
      ),
    );
    expect(first).toMatchObject({
      provider: "mistral",
      model: "mistral-embed",
      baseUrl: endpoint,
      headers: expect.arrayContaining(Object.entries(routingHeaders)),
    });
    expect(first).toEqual(rotated);
    expect(first).not.toEqual(
      await identity({ baseUrl: endpoint, headers: { ...tenantHeaders, "X-Tenant": "tenant-b" } }),
    );
    expect(first).not.toEqual(
      await identity({
        baseUrl: "https://mistral-region-b.example.test/v1",
        headers: tenantHeaders,
      }),
    );
    expect(JSON.stringify(first)).not.toContain("fixture-");
  });

  it("partitions provider-owned headers without leaking them to a remote destination", async () => {
    const providerBaseUrl = "https://provider-region.example.test/v1";
    const mistral = {
      baseUrl: providerBaseUrl,
      apiKey: "fixture-provider-key",
      headers: { "X-Provider-Tenant": "provider-a" },
      models: [],
    };
    const config = { models: { providers: { mistral } } };
    const remoteParams = {
      baseUrl: "https://remote-region.example.test/v1",
      headers: { "X-Tenant": "remote-a" },
    };
    const requestHeaders = await outboundHeaders(remoteParams, config);

    expect(await identity({}, config)).toMatchObject({
      baseUrl: providerBaseUrl,
      headers: [["X-Provider-Tenant", "provider-a"]],
    });
    expect(await identity(remoteParams, config)).toMatchObject({
      baseUrl: "https://remote-region.example.test/v1",
      headers: [["X-Tenant", "remote-a"]],
    });
    expect(requestHeaders).not.toHaveProperty("x-provider-tenant");
    expect(requestHeaders["x-tenant"]).toBe("remote-a");
  });
});
