import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import type { MemoryEmbeddingProviderCreateOptions } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { mistralMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

function create(
  remote: MemoryEmbeddingProviderCreateOptions["remote"] = {},
  config: MemoryEmbeddingProviderCreateOptions["config"] = {},
) {
  return mistralMemoryEmbeddingProviderAdapter.create({
    config,
    provider: "mistral",
    model: "mistral-embed",
    fallback: "none",
    remote: { apiKey: "fixture-mistral-key-before", ...remote },
  });
}

async function identity(...params: Parameters<typeof create>) {
  return (await create(...params)).runtime?.cacheKeyData;
}

async function outboundHeaders(...[remote = {}, config = {}]: Parameters<typeof create>) {
  let headers: IncomingHttpHeaders = {};
  await withServer(
    (request, response) => {
      headers = request.headers;
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }));
    },
    async (origin) => {
      const { provider } = await create({ ...remote, baseUrl: `${origin}/v1` }, config);
      assert(provider, "expected configured Mistral embedding provider");
      await expect(provider.embed("fixture input")).resolves.toEqual([1, 2]);
    },
  );
  return headers;
}

it.each([undefined, "https://API.MISTRAL.AI:443/v1/"])("default identity: %s", async (baseUrl) => {
  expect(await identity({ baseUrl })).toEqual({ provider: "mistral", model: "mistral-embed" });
});

it("partitions endpoints and tenants without including rotated authentication headers", async () => {
  const routingHeaders = {
    "X-Tenant": "tenant-a",
    "User-Agent": "tenant-router/1",
    version: "tenant-api-v1",
  };
  const headers = {
    ...routingHeaders,
    "X-Api-Key": "fixture-proxy-key-before",
    "api-key": "fixture-azure-key-before",
  };
  const firstParams = { baseUrl: "https://mistral-region-a.example.test/v1", headers };
  const first = await identity(firstParams);
  const rotated = await identity({
    ...firstParams,
    apiKey: "fixture-mistral-key-after",
    headers: {
      ...Object.fromEntries(Object.entries(routingHeaders).toReversed()),
      "Api-Key": "fixture-azure-key-after",
      "x-aPI-kEY": "fixture-proxy-key-after",
    },
  });
  expect(await outboundHeaders(firstParams)).toMatchObject(
    Object.fromEntries(
      new Headers({ Authorization: "Bearer fixture-mistral-key-before", ...headers }),
    ),
  );
  expect(first).toMatchObject({
    baseUrl: firstParams.baseUrl,
    headers: expect.arrayContaining(Object.entries(routingHeaders)),
  });
  expect(first).toEqual(rotated);
  expect(first).not.toEqual(
    await identity({ ...firstParams, headers: { ...headers, "X-Tenant": "tenant-b" } }),
  );
  expect(first).not.toEqual(
    await identity({ ...firstParams, baseUrl: "https://mistral-region-b.example.test/v1" }),
  );
  expect(JSON.stringify(first)).not.toContain("fixture-");
});

it("partitions provider-owned headers without leaking them to a remote destination", async () => {
  const mistral = {
    baseUrl: "https://provider-region.example.test/v1",
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
    baseUrl: mistral.baseUrl,
    headers: [["X-Provider-Tenant", "provider-a"]],
  });
  expect(await identity(remoteParams, config)).toMatchObject({
    baseUrl: "https://remote-region.example.test/v1",
    headers: [["X-Tenant", "remote-a"]],
  });
  expect(requestHeaders).not.toHaveProperty("x-provider-tenant");
  expect(requestHeaders["x-tenant"]).toBe("remote-a");
});
