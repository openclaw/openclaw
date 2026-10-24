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

function mockCatalog(ids: string[], rows: unknown[], inventoryStatus = 200) {
  for (const [url, body] of [
    [NVIDIA_MODELS_URL, { data: ids.map((id) => ({ id, object: "model" })) }],
    [NVIDIA_FEATURED_MODELS_URL, { "featured-models": rows }],
  ] as const) {
    const responses = catalogResponses.get(url) ?? [];
    responses.push({
      response: Response.json(body, {
        status: url === NVIDIA_MODELS_URL ? inventoryStatus : 200,
      }),
      finalUrl: url,
      release: vi.fn(),
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
}

function featured(model: string, name: string, context: number, maxOutput: number) {
  return { model, "model-name": name, context, "max-output": maxOutput };
}

describe("nvidia provider catalog", () => {
  it("uses the model inventory for availability while retaining featured ordering", async () => {
    mockCatalog(
      [
        "nvidia/nemotron-3-ultra-550b-a55b",
        "nvidia/nemotron-3.5-super-vl-120b-a12b",
        "nvidia/nemotron-3.5-lightning-30b-a3b",
        "nvidia/unclassified-new-model",
        "nvidia/nemotron-4-340b-reward",
      ],
      [
        featured("z-ai/glm-5.2", "Stale featured model", 202752, 8192),
        featured("nemotron-3.5-super-vl-120b-a12b", "Nemotron 3.5 Super VL", 1048576, 8192),
      ],
    );

    const provider = await buildLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3.5-super-vl-120b-a12b",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
    ]);
    expect(provider.models[0]?.input).toEqual(["text", "image", "video"]);
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledWith({
      auditContext: "nvidia-featured-model-catalog",
      init: { headers: expect.any(Headers) },
      lookupFn: expect.any(Function),
      policy: { allowedHostnames: ["assets.ngc.nvidia.com"] },
      signal: undefined,
      timeoutMs: expect.any(Number),
      url: NVIDIA_FEATURED_MODELS_URL,
      requireHttps: true,
    });
  });

  it("does not treat featured rows as fresh inventory when model discovery fails", async () => {
    mockCatalog([], [featured("z-ai/glm-5.2", "GLM 5.2", 202752, 8192)], 503);

    await expect(buildLiveNvidiaProvider()).rejects.toThrow("HTTP 503");
  });

  it("builds the bundled NVIDIA provider defaults", () => {
    const provider = buildNvidiaProvider();

    expect(provider).toMatchObject({
      baseUrl: "https://integrate.api.nvidia.com/v1",
      api: "openai-completions",
      apiKey: "NVIDIA_API_KEY",
    });
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
      id: "nvidia/nemotron-3.5-super-vl-120b-a12b",
      input: ["text", "image", "video"],
      contextWindow: 1_048_576,
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
    mockCatalog(["moonshotai/kimi-k2.6"], [featured("bad model id", "Bad", 1000, 1000)]);
    mockCatalog(
      ["moonshotai/kimi-k2.6"],
      [featured("moonshotai/kimi-k2.6", "Updated Kimi K2.6", 262144, 8192)],
    );

    await expect(buildLiveNvidiaProvider()).rejects.toThrow("no usable model metadata");
    const second = await buildLiveNvidiaProvider();
    expect(second.models).toMatchObject([
      { id: "moonshotai/kimi-k2.6", name: "Updated Kimi K2.6", contextWindow: 262144 },
    ]);
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(3);
  });
});
