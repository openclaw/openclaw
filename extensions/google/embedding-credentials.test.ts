import { afterEach, expect, it, vi } from "vitest";
import { createGeminiEmbeddingProvider } from "./embedding-provider.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { source: "remote", value: { source: "env", provider: "default", id: "MISSING_HEADER" } },
  { source: "provider", value: { source: "env", provider: "default", id: "MISSING_HEADER" } },
  { source: "remote", value: 42 },
  { source: "provider", value: null },
])("rejects invalid $source embedding headers before egress: $value", async ({ source, value }) => {
  const fetch = vi.spyOn(globalThis, "fetch");
  // Exercise malformed/unresolved runtime input, beyond authored config validation.
  const headers = { "X-Embedding-Auth": value } as unknown as Record<string, string>;
  const path =
    source === "remote" ? "memory.search.remote.headers" : "models.providers.google.headers";

  await expect(
    createGeminiEmbeddingProvider({
      config: {
        models: {
          providers: {
            google: {
              baseUrl: "http://127.0.0.1:19575/v1beta",
              models: [],
              ...(source === "provider" ? { headers } : {}),
            },
          },
        },
      },
      provider: "gemini",
      model: "gemini-embedding-001",
      fallback: "none",
      remote: { apiKey: "synthetic-key", ...(source === "remote" ? { headers } : {}) },
    }),
  ).rejects.toMatchObject({
    name: value && typeof value === "object" ? "UnresolvedSecretInputError" : "Error",
    message: expect.stringContaining(`${path}.X-Embedding-Auth`),
  });
  expect(fetch).not.toHaveBeenCalled();
});
