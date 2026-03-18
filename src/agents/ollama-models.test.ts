import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, requestBodyText, requestUrl } from "../test-helpers/http.js";
import {
  buildOllamaModelDefinition,
  enrichOllamaModelsWithContext,
  isReasoningModelHeuristic,
  isVisionModelHeuristic,
  resolveOllamaApiBase,
  type OllamaTagModel,
} from "./ollama-models.js";

describe("ollama-models", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips /v1 when resolving the Ollama API base", () => {
    expect(resolveOllamaApiBase("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(resolveOllamaApiBase("http://127.0.0.1:11434///")).toBe("http://127.0.0.1:11434");
  });

  it("enriches discovered models with context windows from /api/show", async () => {
    const models: OllamaTagModel[] = [{ name: "llama3:8b" }, { name: "deepseek-r1:14b" }];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (!url.endsWith("/api/show")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      const body = JSON.parse(requestBodyText(init?.body)) as { name?: string };
      if (body.name === "llama3:8b") {
        return jsonResponse({ model_info: { "llama.context_length": 65536 } });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched).toEqual([
      { name: "llama3:8b", contextWindow: 65536, supportsVision: false },
      { name: "deepseek-r1:14b", contextWindow: undefined, supportsVision: false },
    ]);
  });

  it("detects vision models from /api/show projectors field", async () => {
    const models: OllamaTagModel[] = [{ name: "llava:13b" }];
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model_info: { "llama.context_length": 4096 },
        projectors: ["sha256:abc123"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched[0].supportsVision).toBe(true);
    expect(enriched[0].contextWindow).toBe(4096);
  });

  it("detects vision models from /api/show details.families containing clip", async () => {
    const models: OllamaTagModel[] = [{ name: "llama3.2-vision:11b" }];
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model_info: { "mllama.context_length": 131072 },
        details: { families: ["mllama", "clip"] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched[0].supportsVision).toBe(true);
  });

  it("detects vision models from /api/show model_info keys containing clip or vision", async () => {
    const models: OllamaTagModel[] = [{ name: "minicpm-v:8b" }];
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model_info: {
          "minicpm.context_length": 8192,
          "clip.has_vision_encoder": true,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched[0].supportsVision).toBe(true);
  });

  it("marks non-vision models as supportsVision false", async () => {
    const models: OllamaTagModel[] = [{ name: "qwen3:32b" }];
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model_info: { "qwen3.context_length": 131072 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched[0].supportsVision).toBe(false);
  });
});

describe("isReasoningModelHeuristic", () => {
  it("detects standard reasoning model names", () => {
    expect(isReasoningModelHeuristic("deepseek-r1:14b")).toBe(true);
    expect(isReasoningModelHeuristic("qwen3-reasoning:32b")).toBe(true);
    expect(isReasoningModelHeuristic("think-model:7b")).toBe(true);
  });

  it("detects qwq models as reasoning", () => {
    expect(isReasoningModelHeuristic("qwq:32b")).toBe(true);
    expect(isReasoningModelHeuristic("qwq-preview:latest")).toBe(true);
  });

  it("detects o1 models as reasoning", () => {
    expect(isReasoningModelHeuristic("o1-mini")).toBe(true);
    expect(isReasoningModelHeuristic("o1-preview")).toBe(true);
  });

  it("does not false-positive on unrelated names", () => {
    expect(isReasoningModelHeuristic("llama3:8b")).toBe(false);
    expect(isReasoningModelHeuristic("qwen3:32b")).toBe(false);
    expect(isReasoningModelHeuristic("gemma2:9b")).toBe(false);
  });
});

describe("isVisionModelHeuristic", () => {
  it("detects common vision model names", () => {
    expect(isVisionModelHeuristic("llava:13b")).toBe(true);
    expect(isVisionModelHeuristic("bakllava:latest")).toBe(true);
    expect(isVisionModelHeuristic("llama3.2-vision:11b")).toBe(true);
    expect(isVisionModelHeuristic("moondream:latest")).toBe(true);
    expect(isVisionModelHeuristic("minicpm-v:8b")).toBe(true);
    expect(isVisionModelHeuristic("cogvlm2:latest")).toBe(true);
    expect(isVisionModelHeuristic("internvl2:26b")).toBe(true);
    expect(isVisionModelHeuristic("glm-4v:9b")).toBe(true);
  });

  it("does not false-positive on unrelated names", () => {
    expect(isVisionModelHeuristic("llama3:8b")).toBe(false);
    expect(isVisionModelHeuristic("qwen3:32b")).toBe(false);
    expect(isVisionModelHeuristic("deepseek-r1:14b")).toBe(false);
  });
});

describe("buildOllamaModelDefinition", () => {
  it("marks vision models with input text+image when supportsVision is true", () => {
    const model = buildOllamaModelDefinition("llava:13b", 4096, true);
    expect(model.input).toEqual(["text", "image"]);
  });

  it("falls back to name heuristic when supportsVision is undefined", () => {
    const visionModel = buildOllamaModelDefinition("llava:13b", 4096);
    expect(visionModel.input).toEqual(["text", "image"]);

    const textModel = buildOllamaModelDefinition("llama3:8b", 4096);
    expect(textModel.input).toEqual(["text"]);
  });

  it("respects explicit supportsVision=false even for vision-named models", () => {
    const model = buildOllamaModelDefinition("llava:13b", 4096, false);
    expect(model.input).toEqual(["text"]);
  });
});
