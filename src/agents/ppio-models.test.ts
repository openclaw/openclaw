import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverPpioModels,
  PPIO_MODEL_CATALOG,
  staticPpioModelDefinitions,
} from "./ppio-models.js";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_VITEST = process.env.VITEST;

function restoreDiscoveryEnv(): void {
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
  if (ORIGINAL_VITEST === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = ORIGINAL_VITEST;
  }
}

async function runWithDiscoveryEnabled<T>(operation: () => Promise<T>): Promise<T> {
  process.env.NODE_ENV = "development";
  delete process.env.VITEST;
  try {
    return await operation();
  } finally {
    restoreDiscoveryEnv();
  }
}

function makePpioModelsResponse(
  models: Array<{
    id: string;
    display_name?: string;
    model_type?: string;
    context_size?: number;
    max_output_tokens?: number;
    features?: string[];
    endpoints?: string[];
    input_modalities?: string[];
    input_token_price_per_m?: number;
    output_token_price_per_m?: number;
  }>,
): Response {
  return new Response(
    JSON.stringify({
      data: models.map((m) => ({
        model_type: "chat",
        context_size: 128000,
        max_output_tokens: 8192,
        features: [],
        endpoints: ["chat/completions"],
        input_modalities: ["text"],
        input_token_price_per_m: 0,
        output_token_price_per_m: 0,
        ...m,
      })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("ppio-models", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreDiscoveryEnv();
  });

  it("staticPpioModelDefinitions returns entries with required fields", () => {
    const defs = staticPpioModelDefinitions();
    expect(defs.length).toBe(PPIO_MODEL_CATALOG.length);
    for (const def of defs) {
      expect(def.id).toBeTruthy();
      expect(def.name).toBeTruthy();
      expect(typeof def.reasoning).toBe("boolean");
      expect(def.input).toContain("text");
      expect(def.contextWindow).toBeGreaterThan(0);
      expect(def.maxTokens).toBeGreaterThan(0);
      expect(def.cost).toBeDefined();
      expect(def.cost.input).toBeGreaterThanOrEqual(0);
      expect(def.cost.output).toBeGreaterThanOrEqual(0);
    }
  });

  it("static catalog includes deepseek-v3.2 as default model", () => {
    const defs = staticPpioModelDefinitions();
    const ids = defs.map((d) => d.id);
    expect(ids).toContain("deepseek/deepseek-v3.2");
  });

  it("discoverPpioModels returns static catalog in test env", async () => {
    const models = await discoverPpioModels();
    expect(models.length).toBe(PPIO_MODEL_CATALOG.length);
    expect(models[0].id).toBe(PPIO_MODEL_CATALOG[0].id);
  });

  it("discovery parses API response and maps fields correctly", async () => {
    const fetchMock = vi.fn(async () =>
      makePpioModelsResponse([
        {
          id: "deepseek/deepseek-v3.2",
          display_name: "DeepSeek V3.2",
          model_type: "chat",
          context_size: 163840,
          max_output_tokens: 65536,
          features: ["serverless", "function-calling", "reasoning"],
          endpoints: ["chat/completions", "anthropic"],
          input_modalities: ["text"],
          input_token_price_per_m: 20000,
          output_token_price_per_m: 30000,
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await runWithDiscoveryEnabled(() => discoverPpioModels());
    expect(models).toHaveLength(1);
    const model = models[0];
    expect(model.id).toBe("deepseek/deepseek-v3.2");
    expect(model.name).toBe("DeepSeek V3.2");
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text"]);
    expect(model.contextWindow).toBe(163840);
    expect(model.maxTokens).toBe(65536);
    // Price in 0.0001 CNY/M: 20000 → 2 CNY/M → ~$0.278/M
    expect(model.cost.input).toBeGreaterThan(0);
    expect(model.cost.output).toBeGreaterThan(model.cost.input);
  });

  it("discovery maps image/video input modalities to image", async () => {
    const fetchMock = vi.fn(async () =>
      makePpioModelsResponse([
        {
          id: "qwen/qwen3.5-397b-a17b",
          display_name: "Qwen3.5-397B",
          input_modalities: ["text", "image", "video"],
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await runWithDiscoveryEnabled(() => discoverPpioModels());
    expect(models[0].input).toEqual(["text", "image"]);
  });

  it("discovery filters out non-chat models", async () => {
    const fetchMock = vi.fn(async () =>
      makePpioModelsResponse([
        { id: "embedding-model", model_type: "embedding" },
        { id: "deepseek/deepseek-v3.2", model_type: "chat" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await runWithDiscoveryEnabled(() => discoverPpioModels());
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("deepseek/deepseek-v3.2");
  });

  it("discovery falls back to static catalog on HTTP error", async () => {
    const fetchMock = vi.fn(async () => new Response("Server Error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await runWithDiscoveryEnabled(() => discoverPpioModels());
    expect(models.length).toBe(PPIO_MODEL_CATALOG.length);
  });

  it("discovery falls back to static catalog on network error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await runWithDiscoveryEnabled(() => discoverPpioModels());
    expect(models.length).toBe(PPIO_MODEL_CATALOG.length);
  });

  it("discovery falls back to static catalog on empty response", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await runWithDiscoveryEnabled(() => discoverPpioModels());
    expect(models.length).toBe(PPIO_MODEL_CATALOG.length);
  });

  it("discovery passes API key as Authorization header when provided", async () => {
    const fetchMock = vi.fn(async () => makePpioModelsResponse([{ id: "test-model" }]));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await runWithDiscoveryEnabled(() => discoverPpioModels("sk-test-key"));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test-key");
  });

  it("discovery strips serverless from features when checking reasoning", async () => {
    const fetchMock = vi.fn(async () =>
      makePpioModelsResponse([
        {
          id: "non-reasoning-model",
          features: ["serverless", "function-calling"],
        },
        {
          id: "reasoning-model",
          features: ["serverless", "reasoning", "function-calling"],
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await runWithDiscoveryEnabled(() => discoverPpioModels());
    expect(models.find((m) => m.id === "non-reasoning-model")?.reasoning).toBe(false);
    expect(models.find((m) => m.id === "reasoning-model")?.reasoning).toBe(true);
  });
});
