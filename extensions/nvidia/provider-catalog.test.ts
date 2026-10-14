import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLiveNvidiaProvider, buildNvidiaProvider } from "./provider-catalog.js";

const NVIDIA_FEATURED_MODELS_URL =
  "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json";
const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";

const ssrfRuntimeMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  ssrfPolicyFromHttpBaseUrlAllowedHostname: vi.fn((baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  })),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ssrfRuntimeMocks);

const catalogResponses = new Map<
  string,
  Array<{ response: Response; finalUrl: string; release: ReturnType<typeof vi.fn> }>
>();

afterEach(() => {
  clearLiveCatalogCacheForTests();
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockReset();
  ssrfRuntimeMocks.ssrfPolicyFromHttpBaseUrlAllowedHostname.mockClear();
  catalogResponses.clear();
});

function mockFeaturedCatalogResponse(payload: unknown, status = 200, inventoryIds?: string[]) {
  const release = vi.fn();
  const featured =
    (payload as { "featured-models"?: Array<{ model: string }> })["featured-models"] ?? [];
  const ids =
    inventoryIds ??
    featured.map((row) => row.model).filter((id) => typeof id === "string" && !/\s/.test(id));
  for (const [url, body] of [
    [
      NVIDIA_MODELS_URL,
      { data: ids.map((id) => ({ id: id.includes("/") ? id : `nvidia/${id}` })) },
    ],
    [NVIDIA_FEATURED_MODELS_URL, payload],
  ] as const) {
    const responses = catalogResponses.get(url) ?? [];
    responses.push({
      response: Response.json(body, { status }),
      finalUrl: url,
      release: url === NVIDIA_FEATURED_MODELS_URL ? release : vi.fn(),
    });
    catalogResponses.set(url, responses);
  }
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockImplementation(async ({ url }: { url: string }) => {
    const response = catalogResponses.get(url)?.shift();
    if (!response) {
      throw new Error(`Unexpected catalog request: ${url}`);
    }
    return response;
  });
  return release;
}

function mockInventoryAndFeatured(params: {
  ids: string[];
  featured: unknown[];
  inventoryStatus?: number;
  featuredStatus?: number;
}) {
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockImplementation(async ({ url }: { url: string }) => ({
    response:
      url === NVIDIA_MODELS_URL
        ? Response.json(
            { data: params.ids.map((id) => ({ id, object: "model" })) },
            { status: params.inventoryStatus ?? 200 },
          )
        : Response.json(
            { "featured-models": params.featured },
            { status: params.featuredStatus ?? 200 },
          ),
    finalUrl: url,
    release: vi.fn(),
  }));
}

describe("nvidia provider catalog", () => {
  it("uses the model inventory for availability while retaining featured ordering", async () => {
    mockInventoryAndFeatured({
      ids: [
        "nvidia/nemotron-3-ultra-550b-a55b",
        "nvidia/nemotron-3-super-120b-a12b",
        "nvidia/nemotron-3.5-lightning-30b-a3b",
        "nvidia/unclassified-new-model",
        "nvidia/nemotron-4-340b-reward",
      ],
      featured: [
        {
          model: "z-ai/glm-5.2",
          "model-name": "Stale featured model",
          context: 202752,
          "max-output": 8192,
        },
        {
          model: "nemotron-3-super-120b-a12b",
          "model-name": "Nemotron 3 Super",
          context: 1000000,
          "max-output": 8192,
        },
      ],
    });

    const provider = await buildLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
    ]);
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledWith({
      auditContext: "nvidia-featured-model-catalog",
      init: { headers: expect.any(Headers) },
      lookupFn: expect.any(Function),
      policy: { allowedHostnames: ["assets.ngc.nvidia.com"] },
      signal: expect.any(AbortSignal),
      timeoutMs: expect.any(Number),
      url: NVIDIA_FEATURED_MODELS_URL,
      requireHttps: true,
    });
  });

  it("does not treat featured rows as fresh inventory when model discovery fails", async () => {
    mockInventoryAndFeatured({
      ids: [],
      inventoryStatus: 503,
      featured: [
        { model: "z-ai/glm-5.2", "model-name": "GLM 5.2", context: 202752, "max-output": 8192 },
      ],
    });

    await expect(buildLiveNvidiaProvider()).rejects.toThrow("HTTP 503");
  });

  it("builds the bundled NVIDIA provider defaults", () => {
    const provider = buildNvidiaProvider();

    expect(provider.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.apiKey).toBe("NVIDIA_API_KEY");
    expect(provider.models.filter((model) => model.compat?.requiresStringContent !== true)).toEqual(
      [],
    );
    expect(provider.models[0]).toMatchObject({
      contextWindow: 1_048_576,
      maxTokens: 8_192,
      params: {
        chat_template_kwargs: {
          enable_thinking: false,
          force_nonempty_content: true,
        },
      },
    });
    expect(provider.models[2]).toMatchObject({
      id: "nvidia/nemotron-3-super-120b-a12b",
      contextWindow: 1_000_000,
    });
    expect(provider.models.find((model) => model.id === "moonshotai/kimi-k2.6")).toMatchObject({
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 262_144,
      maxTokens: 65_536,
    });
    expect(
      provider.models.find((model) => model.id === "nvidia/nemotron-3.5-lightning-30b-a3b"),
    ).toMatchObject({
      input: ["text"],
      reasoning: true,
      contextWindow: 1_048_576,
      maxTokens: 16_384,
    });
  });

  it("does not cache successful featured catalog responses with no usable rows", async () => {
    mockFeaturedCatalogResponse(
      {
        "featured-models": [
          {
            model: "bad model id",
            "model-name": "Bad",
            context: 1000,
            "max-output": 1000,
          },
        ],
      },
      200,
      ["moonshotai/kimi-k2.6"],
    );
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "moonshotai/kimi-k2.6",
          "model-name": "Updated Kimi K2.6",
          context: 262144,
          "max-output": 8192,
        },
      ],
    });

    await expect(buildLiveNvidiaProvider()).rejects.toThrow("no usable model metadata");
    const second = await buildLiveNvidiaProvider();
    expect(second.models).toMatchObject([
      { id: "moonshotai/kimi-k2.6", name: "Updated Kimi K2.6", contextWindow: 262144 },
    ]);
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(3);
  });
});
