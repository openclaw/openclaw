import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { scanOpenRouterModels } from "./model-scan.js";

const completeMock = vi.hoisted(() =>
  vi.fn(async () => ({
    role: "assistant",
    content: undefined,
  })),
);
const getEnvApiKeyMock = vi.hoisted(() => vi.fn(() => "test-openrouter-key"));

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();

  return {
    ...actual,
    complete: completeMock,
    getModel: () =>
      ({
        id: "openrouter/auto",
        name: "openrouter/auto",
        contextWindow: 20_480,
        maxTokens: 4_096,
        input: ["text", "tools"],
        reasoning: false,
      }) as never,
    getEnvApiKey: getEnvApiKeyMock,
  };
});

beforeEach(() => {
  completeMock.mockClear();
  getEnvApiKeyMock.mockClear();
  getEnvApiKeyMock.mockReturnValue("test-openrouter-key");
});

function createFetchFixture(payload: unknown): typeof fetch {
  return withFetchPreconnect(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("scanOpenRouterModels", () => {
  it("lists free models without probing", async () => {
    const fetchImpl = createFetchFixture({
      data: [
        {
          id: "acme/free-by-pricing",
          name: "Free By Pricing",
          context_length: 16_384,
          max_completion_tokens: 1024,
          supported_parameters: ["tools", "tool_choice", "temperature"],
          modality: "text",
          pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
          created_at: 1_700_000_000,
        },
        {
          id: "acme/free-by-suffix:free",
          name: "Free By Suffix",
          context_length: 8_192,
          supported_parameters: [],
          modality: "text",
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "acme/paid",
          name: "Paid",
          context_length: 4_096,
          supported_parameters: ["tools"],
          modality: "text",
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
      ],
    });

    const results = await scanOpenRouterModels({
      fetchImpl,
      probe: false,
    });

    expect(results.map((entry) => entry.id)).toEqual([
      "acme/free-by-pricing",
      "acme/free-by-suffix:free",
    ]);

    const [byPricing] = results;
    expect(byPricing).toBeTruthy();
    if (!byPricing) {
      throw new Error("Expected pricing-based model result.");
    }
    expect(byPricing.supportsToolsMeta).toBe(true);
    expect(byPricing.supportedParametersCount).toBe(3);
    expect(byPricing.isFree).toBe(true);
    expect(byPricing.tool.skipped).toBe(true);
    expect(byPricing.image.skipped).toBe(true);
  });

  it("requires an API key when probing", async () => {
    getEnvApiKeyMock.mockReturnValue("");
    const fetchImpl = createFetchFixture({ data: [] });
    const envSnapshot = captureEnv(["OPENROUTER_API_KEY"]);
    try {
      delete process.env.OPENROUTER_API_KEY;
      await expect(
        scanOpenRouterModels({
          fetchImpl,
          probe: true,
          apiKey: "",
        }),
      ).rejects.toThrow(/Missing OpenRouter API key/);
    } finally {
      envSnapshot.restore();
    }
  });

  it("treats malformed tool result content as no tool call without crashing", async () => {
    const fetchImpl = createFetchFixture({
      data: [
        {
          id: "acme/probe-malformed",
          name: "Probe Malformed",
          context_length: 8_192,
          supported_parameters: ["tools", "tool_choice"],
          modality: "text",
          pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
          created_at: 1_700_000_000,
        },
      ],
    });

    const results = await scanOpenRouterModels({
      fetchImpl,
      probe: true,
      apiKey: "test-openrouter-key",
      timeoutMs: 50,
      concurrency: 1,
    });

    expect(results).toHaveLength(1);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(results[0]?.tool.ok).toBe(false);
    expect(results[0]?.tool.error).toBe("No tool call returned");
  });

  it("treats non-array assistant content as no tool call without crashing", async () => {
    completeMock.mockResolvedValueOnce({
      role: "assistant",
      content: "this is not an array",
    } as never);

    const fetchImpl = createFetchFixture({
      data: [
        {
          id: "acme/probe-non-array",
          name: "Probe Non-Array",
          context_length: 8_192,
          supported_parameters: ["tools", "tool_choice"],
          modality: "text",
          pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
          created_at: 1_700_000_000,
        },
      ],
    });

    const results = await scanOpenRouterModels({
      fetchImpl,
      probe: true,
      apiKey: "test-openrouter-key",
      timeoutMs: 50,
      concurrency: 1,
    });

    expect(results).toHaveLength(1);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(results[0]?.tool.ok).toBe(false);
    expect(results[0]?.tool.error).toBe("No tool call returned");
  });
});
