import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildNearAIModelDefinition,
  discoverNearAIModels,
  NEARAI_DEFAULT_MODEL_REF,
  NEARAI_MODEL_CATALOG,
} from "./models.js";

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

type NearAITestModel = {
  modelId: string;
  displayName?: string;
  description?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  contextLength?: number;
  inputCostAmount?: number;
  outputCostAmount?: number;
  cacheReadCostAmount?: number;
};

function makeNearAIModel(params: NearAITestModel) {
  return {
    modelId: params.modelId,
    inputCostPerToken: {
      amount: params.inputCostAmount ?? 850,
      scale: 9,
      currency: "USD",
    },
    outputCostPerToken: {
      amount: params.outputCostAmount ?? 3300,
      scale: 9,
      currency: "USD",
    },
    cacheReadCostPerToken: {
      amount: params.cacheReadCostAmount ?? 170,
      scale: 9,
      currency: "USD",
    },
    metadata: {
      contextLength: params.contextLength ?? 202752,
      modelDisplayName: params.displayName ?? params.modelId,
      modelDescription: params.description ?? "General-purpose model",
      architecture: {
        inputModalities: params.inputModalities ?? ["text"],
        outputModalities: params.outputModalities ?? ["text"],
      },
    },
  };
}

function stubNearAIModelsFetch(rows: NearAITestModel[]) {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          models: rows.map((row) => makeNearAIModel(row)),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

describe("nearai models", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreDiscoveryEnv();
  });

  it("buildNearAIModelDefinition applies OpenAI-compatible NEAR compatibility flags", () => {
    const entry = NEARAI_MODEL_CATALOG.find((model) => model.id === "zai-org/GLM-5.1-FP8");
    if (!entry) {
      throw new Error("expected default NEAR AI model");
    }

    const def = buildNearAIModelDefinition(entry);
    expect(NEARAI_DEFAULT_MODEL_REF).toBe("nearai/zai-org/GLM-5.1-FP8");
    expect(def.id).toBe(entry.id);
    expect(def.input).toEqual(["text"]);
    expect(def.cost.input).toBe(0.85);
    expect(def.compat).toMatchObject({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    });
  });

  it("maps public catalog rows to OpenClaw model definitions", async () => {
    stubNearAIModelsFetch([
      {
        modelId: "zai-org/GLM-5.1-FP8",
        displayName: "GLM 5.1",
        description: "Built for complex reasoning and coding",
        inputModalities: ["text"],
        outputModalities: ["text"],
        contextLength: 202752,
        inputCostAmount: 850,
        outputCostAmount: 3300,
        cacheReadCostAmount: 170,
      },
      {
        modelId: "Qwen/Qwen3-VL-30B-A3B-Instruct",
        displayName: "Qwen3 VL",
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        contextLength: 256000,
        inputCostAmount: 150,
        outputCostAmount: 550,
        cacheReadCostAmount: 30,
      },
    ]);

    const models = await runWithDiscoveryEnabled(() => discoverNearAIModels({ retryDelayMs: 0 }));
    const glm = models.find((model) => model.id === "zai-org/GLM-5.1-FP8");
    const qwenVl = models.find((model) => model.id === "Qwen/Qwen3-VL-30B-A3B-Instruct");

    expect(glm).toMatchObject({
      name: "GLM 5.1",
      reasoning: true,
      input: ["text"],
      contextWindow: 202752,
      maxTokens: 65536,
      cost: {
        input: 0.85,
        output: 3.3,
        cacheRead: 0.17,
        cacheWrite: 0,
      },
    });
    expect(qwenVl?.input).toEqual(["text", "image"]);
    expect(qwenVl?.compat?.maxTokensField).toBe("max_tokens");
  });

  it("filters non-chat utility rows from discovery", async () => {
    stubNearAIModelsFetch([
      {
        modelId: "openai/privacy-filter",
        outputModalities: ["text"],
      },
      {
        modelId: "Qwen/Qwen3-Embedding-0.6B",
        outputModalities: ["embedding"],
      },
      {
        modelId: "black-forest-labs/FLUX.2-klein-4B",
        outputModalities: ["image"],
      },
      {
        modelId: "zai-org/GLM-5.1-FP8",
        outputModalities: ["text"],
      },
    ]);

    const models = await runWithDiscoveryEnabled(() => discoverNearAIModels({ retryDelayMs: 0 }));
    expect(models.map((model) => model.id)).toEqual(["zai-org/GLM-5.1-FP8"]);
  });

  it("falls back to the static catalog after retryable discovery failures", async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND cloud-api.near.ai" },
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await runWithDiscoveryEnabled(() => discoverNearAIModels({ retryDelayMs: 0 }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(models.map((model) => model.id)).toEqual(NEARAI_MODEL_CATALOG.map((model) => model.id));
  });
});
