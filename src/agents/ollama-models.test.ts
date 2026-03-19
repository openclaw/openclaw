import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, requestBodyText, requestUrl } from "../test-helpers/http.js";
import {
  buildOllamaModelDefinition,
  enrichOllamaModelsWithContext,
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
      { name: "llama3:8b", contextWindow: 65536, vision: false },
      { name: "deepseek-r1:14b", contextWindow: undefined, vision: false },
    ]);
  });

  it("detects vision models from /api/show projector keys", async () => {
    const models: OllamaTagModel[] = [{ name: "llama3.2-vision:11b" }];
    const fetchMock = vi.fn(async (_input: string | URL | Request) => {
      return jsonResponse({
        model_info: {
          "general.architecture": "mllama",
          "mllama.context_length": 131072,
          "clip.block_count": 32,
          "projector.type": "cross_attention",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched).toEqual([
      { name: "llama3.2-vision:11b", contextWindow: 131072, vision: true },
    ]);
  });

  describe("isVisionModelHeuristic", () => {
    it.each([
      "qwen3-vl:235b-cloud",
      "llama3.2-vision:11b",
      "llava:13b",
      "bakllava:7b",
      "moondream:1.8b",
      "minicpm-v:8b",
      "internvl2.5:78b",
    ])("detects %s as a vision model", (modelId) => {
      expect(isVisionModelHeuristic(modelId)).toBe(true);
    });

    it.each(["llama3:8b", "deepseek-r1:14b", "glm-4:9b", "qwen3:32b", "mistral:7b"])(
      "does not flag %s as a vision model",
      (modelId) => {
        expect(isVisionModelHeuristic(modelId)).toBe(false);
      },
    );
  });

  describe("buildOllamaModelDefinition", () => {
    it("sets input to text+image for vision models by name", () => {
      const def = buildOllamaModelDefinition("qwen3-vl:235b-cloud");
      expect(def.input).toEqual(["text", "image"]);
    });

    it("sets input to text+image when vision opt is true", () => {
      const def = buildOllamaModelDefinition("custom-model:latest", undefined, { vision: true });
      expect(def.input).toEqual(["text", "image"]);
    });

    it("sets input to text only for non-vision models", () => {
      const def = buildOllamaModelDefinition("llama3:8b");
      expect(def.input).toEqual(["text"]);
    });
  });
});
