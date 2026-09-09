import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, expect, it } from "vitest";
import { buildXaiCatalogModels, resolveXaiCatalogEntry } from "./model-definitions.js";
import { buildLiveXaiOAuthProvider } from "./provider-catalog.js";

afterEach(clearLiveCatalogCacheForTests);

it.each([true, false])(
  "preserves a supported OAuth alias with backend metadata=%s",
  async (withBackend) => {
    const provider = await buildLiveXaiOAuthProvider({
      discoveryApiKey: "synthetic-capability-fixture",
      fetchGuard: async ({ url }) => ({
        response: Response.json({
          data: [{ id: "grok-latest", ...(withBackend ? { api_backend: "responses" } : {}) }],
        }),
        finalUrl: url,
        release: async () => undefined,
      }),
    });
    expect(provider.models).toEqual([
      expect.objectContaining({
        id: "grok-latest",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ]);
  },
);

it.each([
  { id: "grok-3", reasoning: false, input: ["text"], maxTokens: 64_000 },
  { id: "grok-3-mini-fast", reasoning: true, input: ["text"], maxTokens: 64_000 },
  { id: "grok-4.20-reasoning", reasoning: true, input: ["text", "image"], maxTokens: 30_000 },
  { id: "grok-4.20-non-reasoning", reasoning: false, input: ["text", "image"], maxTokens: 30_000 },
])(
  "keeps supported capabilities separate from inventory and pricing for $id",
  ({ id, ...capabilities }) => {
    expect(resolveXaiCatalogEntry(id)).toMatchObject({
      id,
      ...capabilities,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(buildXaiCatalogModels().some((model) => model.id === id)).toBe(false);
  },
);
