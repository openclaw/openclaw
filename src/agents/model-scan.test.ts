import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { ensureImageInput, scanOpenRouterModels } from "./model-scan.js";

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
    const fetchImpl = createFetchFixture({ data: [] });
    await withEnvAsync({ OPENROUTER_API_KEY: undefined }, async () => {
      await expect(
        scanOpenRouterModels({
          fetchImpl,
          probe: true,
          apiKey: "",
        }),
      ).rejects.toThrow(/Missing OpenRouter API key/);
    });
  });
});

describe("ensureImageInput", () => {
  const baseModel = {
    id: "test/model",
    provider: "openai-completions",
    contextWindow: 4096,
    maxTokens: 1024,
  } as const;

  it("adds image to model without input field (undefined)", () => {
    const model = { ...baseModel, input: undefined } as unknown as Parameters<
      typeof ensureImageInput
    >[0];
    const result = ensureImageInput(model);
    expect(result.input).toContain("image");
    expect(result.input).toBeDefined();
    expect(Array.isArray(result.input)).toBe(true);
  });

  it("adds image to model with null input", () => {
    const model = { ...baseModel, input: null } as unknown as Parameters<
      typeof ensureImageInput
    >[0];
    const result = ensureImageInput(model);
    expect(result.input).toContain("image");
    expect(result.input).toBeDefined();
    expect(Array.isArray(result.input)).toBe(true);
  });

  it("adds image to model with empty input array", () => {
    const model = { ...baseModel, input: [] as ("text" | "image")[] };
    const result = ensureImageInput(model);
    expect(result.input).toContain("image");
    expect(result.input).toHaveLength(1);
  });

  it("preserves existing image capability without modification", () => {
    const model = { ...baseModel, input: ["text", "image"] as ("text" | "image")[] };
    const result = ensureImageInput(model);
    expect(result.input).toEqual(["text", "image"]);
    expect(result.input).toHaveLength(2);
  });

  it("adds image to text-only model while preserving text", () => {
    const model = { ...baseModel, input: ["text"] as ("text" | "image")[] };
    const result = ensureImageInput(model);
    expect(result.input).toContain("image");
    expect(result.input).toContain("text");
  });
});
