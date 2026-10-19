import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGoogleLiveCatalogProvider } from "./provider-catalog-runtime.js";
import {
  buildGoogleStaticCatalogProvider,
  buildGoogleVertexStaticCatalogProvider,
} from "./provider-catalog.js";

const geminiFields = {
  reasoning: true,
  input: ["text", "image", "video"],
  contextWindow: 1_048_576,
  maxTokens: 65_536,
  compat: { codeMode: "preferred" },
};
const thinkingLevelMap = { minimal: null };
function expectedGemini(id: string, name: string, hasThinkingFloor = false) {
  return expect.objectContaining({
    id,
    name,
    ...geminiFields,
    ...(hasThinkingFloor ? { thinkingLevelMap } : {}),
  });
}
function liveRow(id: string, displayName = id, overrides: Record<string, unknown> = {}) {
  return {
    name: `models/${id}`,
    displayName,
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportedGenerationMethods: ["generateContent"],
    thinking: true,
    ...overrides,
  };
}
function inventory(body: unknown): LiveModelCatalogFetchGuard {
  return vi.fn(async ({ url }) => ({
    response: Response.json(body),
    finalUrl: url,
    release: async () => undefined,
  }));
}
function discover(fetchGuard: LiveModelCatalogFetchGuard, strict = false) {
  return buildGoogleLiveCatalogProvider({
    discoveryMode: strict ? "strict" : undefined,
    apiKey: "GEMINI_API_KEY",
    discoveryApiKey: "resolved-google-key",
    fetchGuard,
  });
}

describe("google provider catalog", () => {
  beforeEach(() => clearLiveCatalogCacheForTests());

  it("keeps Google AI Studio and Vertex model ids aligned", () => {
    expect(buildGoogleVertexStaticCatalogProvider().models.map((model) => model.id)).toEqual(
      buildGoogleStaticCatalogProvider().models.map((model) => model.id),
    );
    expect(buildGoogleStaticCatalogProvider().models[0]).toEqual({
      id: "gemini-4-argon",
      name: "Gemini 4 Argon",
      ...geminiFields,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap,
    });
    expect(
      buildGoogleStaticCatalogProvider().models.find((model) => model.id === "gemini-3.8-flash"),
    ).toEqual({
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      ...geminiFields,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap,
    });
  });

  it("builds the authenticated text catalog from Google models.list metadata", async () => {
    const release = vi.fn(async () => undefined);
    const firstPage = {
      models: [
        liveRow("gemini-3.6-flash", "Gemini 3.6 Flash", {
          supportedGenerationMethods: ["generateContent", "countTokens"],
        }),
        liveRow("gemini-3.7-flash", "Gemini 3.7 Flash"),
        liveRow("gemini-3.8-flash", "Gemini 3.8 Flash"),
        liveRow("gemma-3-1b-it", "Gemma 3 1B", { thinking: undefined }),
        liveRow("gemini-3.1-flash-image"),
        liveRow("gemini-embedding-2-preview", undefined, {
          supportedGenerationMethods: ["embedContent"],
        }),
      ],
      nextPageToken: "page-2",
    };
    const secondPage = {
      models: [
        liveRow("gemini-4-argon", "Gemini 4 Argon"),
        liveRow("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite"),
        liveRow("gemma-3-4b-it", "Gemma 3 4B", { thinking: undefined }),
      ],
    };
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: Response.json(
        new URL(url).searchParams.get("pageToken") === "page-2" ? secondPage : firstPage,
      ),
      finalUrl: url,
      release,
    }));

    // This projection fixture must not consume the pagination budget during cold imports.
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const provider = await discover(fetchGuard, true).finally(() => clock.mockRestore());

    expect(provider.apiKey).toBe("GEMINI_API_KEY");
    expect(provider.models).toEqual([
      expectedGemini("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite"),
      expectedGemini("gemini-3.6-flash", "Gemini 3.6 Flash"),
      expectedGemini("gemini-3.7-flash", "Gemini 3.7 Flash", true),
      expectedGemini("gemini-3.8-flash", "Gemini 3.8 Flash", true),
      expectedGemini("gemini-4-argon", "Gemini 4 Argon", true),
      expect.objectContaining({
        id: "gemma-3-1b-it",
        name: "Gemma 3 1B",
        input: ["text"],
      }),
      expect.objectContaining({
        id: "gemma-3-4b-it",
        name: "Gemma 3 4B",
        input: ["text", "image"],
      }),
    ]);
    expect(
      provider.models
        .filter((model) => model.id.startsWith("gemma-"))
        .every((model) => model.compat === undefined),
    ).toBe(true);
    const request = vi.mocked(fetchGuard).mock.calls[0]?.[0];
    expect(request?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    );
    expect(new Headers(request?.init?.headers).get("x-goog-api-key")).toBe("resolved-google-key");
    expect(vi.mocked(fetchGuard).mock.calls[1]?.[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=page-2",
    );
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("propagates static compat to discovered id variants of the same weights", async () => {
    const cases: ReadonlyArray<{ id: string; compat: { codeMode: string } | undefined }> = [
      { id: "gemini-3.5-flash", compat: { codeMode: "preferred" } },
      { id: "gemini-3.5-flash-preview-06-17", compat: { codeMode: "preferred" } },
      { id: "gemini-3.1-pro-preview-05-06", compat: { codeMode: "preferred" } },
      { id: "gemini-flash-latest", compat: { codeMode: "preferred" } },
      { id: "gemini-flash-lite-latest", compat: { codeMode: "preferred" } },
      { id: "gemini-pro-latest", compat: { codeMode: "preferred" } },
      // Dated variant of unflagged weights resolves but carries no compat.
      { id: "gemini-2.5-flash-preview-05-20", compat: undefined },
      // Unknown family member fails closed: no static entry, no compat.
      { id: "gemini-3.9-flash", compat: undefined },
    ];
    const fetchGuard = inventory({ models: cases.map(({ id }) => liveRow(id)) });

    const provider = await buildGoogleLiveCatalogProvider({
      apiKey: "GEMINI_API_KEY",
      fetchGuard,
    });

    for (const { id, compat } of cases) {
      const model = provider.models.find((entry) => entry.id === id);
      expect(model, id).toBeDefined();
      expect(model?.compat, id).toEqual(compat);
    }
  });

  it.each([{}])("preserves a successful empty text inventory: %j", async (body) => {
    const fetchGuard = inventory(body);

    const provider = await discover(fetchGuard, true);

    expect(provider.models).toEqual([]);
    const advisory = await discover(fetchGuard);
    expect(advisory.models).toEqual(buildGoogleStaticCatalogProvider().models);
  });

  it.each([{ models: "invalid" }, { models: [null] }])(
    "rejects a malformed inventory: %j",
    async (body) => {
      const fetchGuard = inventory(body);
      await expect(
        buildGoogleLiveCatalogProvider({
          discoveryMode: "strict",
          apiKey: "google-key",
          fetchGuard,
        }),
      ).rejects.toThrow("invalid model");
    },
  );
});
