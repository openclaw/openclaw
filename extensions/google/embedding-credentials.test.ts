import { afterEach, expect, it, vi } from "vitest";
import { createGeminiEmbeddingProvider } from "./embedding-provider.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { source: "remote", value: { source: "env", provider: "default", id: "MISSING_HEADER" } },
  { source: "provider", value: { source: "env", provider: "default", id: "MISSING_HEADER" } },
  { source: "remote", value: 42 },
  { source: "provider", value: null },
  { source: "remote", value: undefined },
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
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";

it("keeps an empty remote override from inheriting Google's billing header", async () => {
  const claim = await acquireTestPortBlock({ offsets: [0] });
  const requests: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    request.resume();
    requests.push(request.headers);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ embedding: { values: [1, 0] } }));
  });
  try {
    server.listen(claim.port, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${claim.port}/v1beta`;
    const { provider } = await createGeminiEmbeddingProvider({
      config: {
        models: {
          providers: {
            google: {
              baseUrl,
              headers: { "x-goog-user-project": "provider-project" },
              models: [],
            },
          },
        },
      },
      provider: "gemini",
      model: "gemini-embedding-001",
      fallback: "none",
      remote: { apiKey: "synthetic-key", headers: { "x-goog-user-project": "" } },
    });
    await expect(provider.embed("synthetic query", { inputType: "query" })).resolves.toEqual([
      1, 0,
    ]);
    expect(requests).toMatchObject([{ "x-goog-user-project": "" }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await claim.release();
  }
});
