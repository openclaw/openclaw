import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./embedding-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedding-provider.js")>();
  return { ...actual, createDeepInfraEmbeddingProvider: vi.fn() };
});

import { createDeepInfraEmbeddingProvider } from "./embedding-provider.js";
import { DEEPINFRA_BASE_URL } from "./media-models.js";
import { deepinfraMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

const mockCreate = vi.mocked(createDeepInfraEmbeddingProvider);

function stubClient(client: {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
}): void {
  mockCreate.mockResolvedValue({
    provider: {} as never,
    client: { ssrfPolicy: undefined, ...client },
  });
}

async function cacheKeyData(): Promise<Record<string, unknown>> {
  const result = await deepinfraMemoryEmbeddingProviderAdapter.create({} as never);
  return result.runtime.cacheKeyData as Record<string, unknown>;
}

describe("deepinfraMemoryEmbeddingProviderAdapter cache identity", () => {
  beforeEach(() => mockCreate.mockReset());

  it("keeps the shipped default identity (no baseUrl) for the default endpoint", async () => {
    stubClient({
      baseUrl: DEEPINFRA_BASE_URL,
      headers: { Authorization: "Bearer redacted" }, // pragma: allowlist secret
      model: "BAAI/bge-m3",
    });
    expect(await cacheKeyData()).toEqual({ provider: "deepinfra", model: "BAAI/bge-m3" });
  });

  it("scopes cache identity by base URL when a custom endpoint is configured", async () => {
    stubClient({
      baseUrl: "https://deepinfra.proxy.internal/v1/openai",
      headers: { Authorization: "Bearer redacted" }, // pragma: allowlist secret
      model: "BAAI/bge-m3",
    });
    expect(await cacheKeyData()).toEqual({
      provider: "deepinfra",
      baseUrl: "https://deepinfra.proxy.internal/v1/openai",
      model: "BAAI/bge-m3",
    });
  });

  it("hashes custom header identity without leaking raw values", async () => {
    stubClient({
      baseUrl: DEEPINFRA_BASE_URL,
      headers: {
        Authorization: "Bearer redacted", // pragma: allowlist secret
        "X-Tenant": "tenant-a",
      },
      model: "BAAI/bge-m3",
    });
    const data = await cacheKeyData();
    expect(data.headersHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(data)).not.toContain("tenant-a");
  });
});
