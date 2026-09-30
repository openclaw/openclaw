import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isProviderApiKeyConfiguredMock = vi.hoisted(() => vi.fn<(p: unknown) => boolean>());
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderApiKeyConfigured: isProviderApiKeyConfiguredMock,
}));

import { discoverDeepInfraModels, discoverDeepInfraSurfaces } from "./provider-models.js";
import {
  buildDeepInfraModelDefinition,
  DEEPINFRA_MODEL_CATALOG,
} from "./provider-static-catalog.js";

const DEEPINFRA_MODELS_URL =
  "https://api.deepinfra.com/v1/openai/models?sort_by=openclaw&filter=with_meta";

beforeEach(() => {
  clearLiveCatalogCacheForTests();
  isProviderApiKeyConfiguredMock.mockReset();
  isProviderApiKeyConfiguredMock.mockReturnValue(false);
});

function makeAgentModelEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "openai/gpt-oss-120b",
    object: "model",
    owned_by: "deepinfra",
    metadata: {
      description: "gpt-oss-120b",
      context_length: 131072,
      max_tokens: 65536,
      pricing: {
        input_tokens: 3,
        output_tokens: 15,
        cache_read_tokens: 0.3,
      },
      tags: ["chat", "vlm", "vision", "reasoning_effort", "prompt_cache", "reasoning"],
    },
    ...overrides,
  };
}

function surfaceEntry(id: string, tags: string[], metadata: Record<string, unknown> = {}) {
  return makeAgentModelEntry({ id, metadata: { tags, ...metadata } });
}

function expectedStaticChatCatalog() {
  return DEEPINFRA_MODEL_CATALOG.map(buildDeepInfraModelDefinition);
}

async function withFetchPathTest(
  mockFetch: ReturnType<typeof vi.fn>,
  envOverrides: Record<string, string | undefined>,
  runAssertions: () => Promise<void>,
) {
  for (const [key, value] of Object.entries(envOverrides)) {
    vi.stubEnv(key, value);
  }
  vi.stubGlobal("fetch", mockFetch);
  try {
    await runAssertions();
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.restoreAllMocks();
});

function mockProjectionFetch(projection: () => Promise<Response> | Response) {
  return vi.fn(async (url: string) => {
    if (url === "https://api.deepinfra.com/models/list") {
      return Response.json([
        {
          model_name: "fixture/native-only",
          pricing: { type: "tokens", cents_per_input_token: 0.0002, cents_per_output_token: 0.001 },
        },
      ]);
    }
    expect(url).toBe(DEEPINFRA_MODELS_URL);
    return projection();
  });
}

function requireMetadataFetchCall(mockFetch: ReturnType<typeof vi.fn>): [unknown, unknown] {
  const call = mockFetch.mock.calls.find(([url]) => url === DEEPINFRA_MODELS_URL);
  if (!call) {
    throw new Error("expected DeepInfra models fetch call");
  }
  return call as [unknown, unknown];
}

describe("buildDeepInfraModelDefinition", () => {
  it("preserves an explicitly configured thinkingFormat", () => {
    const built = buildDeepInfraModelDefinition({
      id: "deepseek-ai/DeepSeek-V3.2",
      name: "DeepSeek V3.2",
      compat: { thinkingFormat: "openai" },
    } as never);
    expect(built.compat?.thinkingFormat).toBe("openai");
  });
});

describe("DeepInfra pre-auth discovery", () => {
  it.each([
    { key: "sk-fixture", live: true },
    { key: "   ", live: false },
    { key: undefined, live: false },
  ])("discovers only with a configured environment key: $live", async ({ key, live }) => {
    const mockFetch = mockProjectionFetch(() => Response.json({ data: [makeAgentModelEntry()] }));
    await withFetchPathTest(mockFetch, {}, async () => {
      expect((await discoverDeepInfraSurfaces({ env: { DEEPINFRA_API_KEY: key } })).live).toBe(
        live,
      );
      expect(mockFetch).toHaveBeenCalledTimes(live ? 1 : 0);
    });
    if (live) {
      expect(isProviderApiKeyConfiguredMock).not.toHaveBeenCalled();
    }
  });

  it("discovers with a saved profile when the environment has no key", async () => {
    isProviderApiKeyConfiguredMock.mockReturnValue(true);
    const mockFetch = mockProjectionFetch(() => Response.json({ data: [makeAgentModelEntry()] }));
    await withFetchPathTest(mockFetch, {}, async () => {
      expect(
        (await discoverDeepInfraSurfaces({ env: {}, agentDir: "/tmp/openclaw-agent" })).live,
      ).toBe(true);
    });
    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledWith({
      provider: "deepinfra",
      agentDir: "/tmp/openclaw-agent",
    });
  });
});

describe("discoverDeepInfraModels", () => {
  it("fetches the openclaw-projection endpoint and parses chat-surface entries when an API key is configured", async () => {
    const mockFetch = mockProjectionFetch(
      vi.fn().mockResolvedValue(Response.json({ data: [makeAgentModelEntry()] })),
    );

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      const models = await discoverDeepInfraModels();
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [fetchUrl, fetchInit] = requireMetadataFetchCall(mockFetch);
      const fetchSignal = Reflect.get(fetchInit ?? {}, "signal");
      const fetchHeaders = Reflect.get(fetchInit ?? {}, "headers");
      expect(fetchUrl).toBe(DEEPINFRA_MODELS_URL);
      expect(fetchSignal).toBeInstanceOf(AbortSignal);
      expect(fetchHeaders).toBeInstanceOf(Headers);
      expect((fetchHeaders as Headers).get("Accept")).toBe("application/json");
      expect(models).toEqual([
        {
          id: "openai/gpt-oss-120b",
          name: "openai/gpt-oss-120b",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 131072,
          maxTokens: 65536,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: { supportsUsageInStreaming: true },
        },
      ]);
    });
  });

  it("preserves bundled reasoning and compat while keeping live model facts authoritative", async () => {
    const rows = [
      surfaceEntry("deepseek-ai/DeepSeek-V4-Pro", ["chat"], {
        context_length: 96000,
        max_tokens: 4096,
        pricing: { input_tokens: 4, output_tokens: 8, cache_read_tokens: 0.4 },
      }),
      surfaceEntry("stepfun-ai/Step-3.7-Flash", ["chat", "vlm", "vision"], {
        context_length: 192000,
        max_tokens: 16384,
        pricing: { input_tokens: 0.2, output_tokens: 1.15 },
      }),
      surfaceEntry("deepseek-ai/DeepSeek-V3.2", ["chat", "reasoning"]),
      surfaceEntry("unlisted/no-reasoning", ["chat"]),
      surfaceEntry("unlisted/with-reasoning", ["chat", "reasoning_effort"]),
    ];
    const mockFetch = mockProjectionFetch(vi.fn().mockResolvedValue(Response.json({ data: rows })));
    DEEPINFRA_MODEL_CATALOG.push(DEEPINFRA_MODEL_CATALOG[0]!);

    try {
      await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
        const models = await discoverDeepInfraModels();

        expect(models.slice(0, rows.length)).toMatchObject([
          {
            id: "deepseek-ai/DeepSeek-V4-Pro",
            reasoning: true,
            input: ["text"],
            contextWindow: 96000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: {
              codeMode: "capable",
              supportsUsageInStreaming: true,
              thinkingFormat: "deepseek",
            },
          },
          {
            id: "stepfun-ai/Step-3.7-Flash",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 192000,
            maxTokens: 16384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          { id: "deepseek-ai/DeepSeek-V3.2", reasoning: false },
          { id: "unlisted/no-reasoning", reasoning: false },
          { id: "unlisted/with-reasoning", reasoning: true },
        ]);
        expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
      });
    } finally {
      DEEPINFRA_MODEL_CATALOG.pop();
    }
  });

  it("skips entries with no metadata or no surface tag, and deduplicates ids", async () => {
    const mockFetch = mockProjectionFetch(
      vi.fn().mockResolvedValue(
        Response.json({
          data: [
            { id: "BAAI/bge-m3", object: "model", metadata: null },
            makeAgentModelEntry({
              id: "untagged/model",
              metadata: { context_length: 1, max_tokens: 1, pricing: {}, tags: [] },
            }),
            makeAgentModelEntry(),
            makeAgentModelEntry(),
          ],
        }),
      ),
    );

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      const models = await discoverDeepInfraModels();
      expect(models.map((m) => m.id)).toEqual(["openai/gpt-oss-120b"]);
    });
  });

  it("falls back to the static catalog when no API key is configured (skips network entirely)", async () => {
    const mockFetch = vi.fn();

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: undefined }, async () => {
      const models = await discoverDeepInfraModels();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(models).toEqual(expectedStaticChatCatalog());
    });
  });

  it.each([
    {
      payload: { data: {} },
      error: "Live model catalog response must be an array or { data: [] }",
    },
    {
      payload: { data: [{ id: "broken/model", metadata: true }] },
      error: "metadata discovery unavailable",
    },
    {
      payload: { data: [{ id: "broken/model", metadata: { tags: "chat" } }] },
      error: "metadata discovery unavailable",
    },
    {
      payload: { data: [makeAgentModelEntry(), { id: "broken/model", metadata: { tags: [42] } }] },
      error: "metadata discovery unavailable",
    },
  ])("rejects malformed model payloads without caching them: %j", async ({ payload, error }) => {
    const mockFetch = mockProjectionFetch(
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(payload))
        .mockResolvedValueOnce(
          Response.json({ data: [makeAgentModelEntry({ id: "recovered/model" })] }),
        ),
    );

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      await expect(discoverDeepInfraModels()).rejects.toThrow(error);
      expect((await discoverDeepInfraModels()).map((m) => m.id)).toEqual(["recovered/model"]);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  it("retains and caches a successful empty catalog", async () => {
    const mockFetch = mockProjectionFetch(
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ data: [] }))
        .mockResolvedValueOnce(
          Response.json({ data: [makeAgentModelEntry({ id: "recovered/model" })] }),
        ),
    );

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      expect(await discoverDeepInfraModels()).toEqual([]);
      expect(await discoverDeepInfraModels()).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

describe("discoverDeepInfraSurfaces (per-surface bucketing)", () => {
  it("buckets unique surface tags while ignoring unknown and prototype-named tags", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          surfaceEntry("anthropic/claude-sonnet-4-6", [
            "chat",
            "vlm",
            "vision",
            "prompt_cache",
            "constructor",
            "toString",
            "__proto__",
            "chat",
          ]),
          surfaceEntry("BAAI/bge-m3", ["embed"]),
          surfaceEntry("black-forest-labs/FLUX-1-schnell", ["image-gen"], {
            pricing: { per_image_unit: 0.003 },
            default_width: 1024,
            default_height: 1024,
            default_iterations: 4,
          }),
          surfaceEntry("Wan-AI/Wan2.6-T2V", ["video-gen"]),
          surfaceEntry("Qwen/Qwen3-TTS", ["tts"]),
          surfaceEntry("openai/whisper-large-v3-turbo", ["stt"]),
        ],
      }),
    );

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      const catalog = await discoverDeepInfraSurfaces();
      expect(catalog.live).toBe(true);
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(catalog.chat.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4-6"]);
      expect(catalog.vlm.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4-6"]);
      expect(catalog.embed.map((m) => m.id)).toEqual(["BAAI/bge-m3"]);
      expect(catalog.imageGen.map((m) => m.id)).toEqual(["black-forest-labs/FLUX-1-schnell"]);
      expect(catalog.imageGen[0]?.defaultWidth).toBe(1024);
      expect(catalog.imageGen[0]?.pricing.per_image_unit).toBe(0.003);
      expect(catalog.videoGen.map((m) => m.id)).toEqual(["Wan-AI/Wan2.6-T2V"]);
      expect(catalog.tts.map((m) => m.id)).toEqual(["Qwen/Qwen3-TTS"]);
      expect(catalog.stt.map((m) => m.id)).toEqual(["openai/whisper-large-v3-turbo"]);
    });
  });

  it("drops malformed live numeric metadata", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          surfaceEntry("bad/chat", ["chat"], { context_length: -1, max_tokens: 1.5 }),
          surfaceEntry("bad/image", ["image-gen"], {
            default_width: Number.POSITIVE_INFINITY,
            default_height: 1024.5,
            default_iterations: 0,
          }),
        ],
      }),
    );

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      const catalog = await discoverDeepInfraSurfaces();

      expect(catalog.chat[0]).toMatchObject({ id: "bad/chat" });
      expect(catalog.chat[0]?.contextWindow).toBeUndefined();
      expect(catalog.chat[0]?.maxTokens).toBeUndefined();
      expect(catalog.imageGen[0]).toMatchObject({ id: "bad/image" });
      expect(catalog.imageGen[0]?.defaultWidth).toBeUndefined();
      expect(catalog.imageGen[0]?.defaultHeight).toBeUndefined();
      expect(catalog.imageGen[0]?.defaultIterations).toBeUndefined();
    });
  });

  it("returns the manifest static fallback (live=false) when no API key is configured", async () => {
    const mockFetch = vi.fn();

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: undefined }, async () => {
      const catalog = await discoverDeepInfraSurfaces();
      expect(catalog.live).toBe(false);
      expect(catalog.chat.length).toBeGreaterThan(0);
      // Non-chat surfaces in the static fallback live in TS constants because
      // the manifest schema only validates chat-shaped rows.
      expect(catalog.imageGen.map((m) => m.id)).toContain("black-forest-labs/FLUX-1-schnell");
      expect(catalog.tts.map((m) => m.id)).toContain("Qwen/Qwen3-TTS");
      expect(catalog.stt.map((m) => m.id)).toContain("openai/whisper-large-v3-turbo");
      // No static video-gen fallback — live discovery picks up text-to-video
      // models when the backend tags them. The live-discovery test above
      // covers the video-gen bucketing path.
      expect(catalog.videoGen).toEqual([]);
      expect(catalog.embed.map((m) => m.id)).toContain("BAAI/bge-m3");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
