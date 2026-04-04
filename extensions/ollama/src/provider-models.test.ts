import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, requestBodyText, requestUrl } from "../../../src/test-helpers/http.js";
import {
  buildOllamaModelDefinition,
  detectVisionFromShowResponse,
  enrichOllamaModelsWithContext,
  isVisionModelHeuristic,
  resolveOllamaApiBase,
  type OllamaTagModel,
} from "./provider-models.js";

describe("ollama provider models", () => {
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
      { name: "llama3:8b", contextWindow: 65536, vision: undefined },
      { name: "deepseek-r1:14b", contextWindow: undefined, vision: undefined },
    ]);
  });

  it("enriches discovered models with vision capability from /api/show", async () => {
    const models: OllamaTagModel[] = [
      { name: "llava:13b" },
      { name: "llama3:8b" },
      { name: "llama3.2-vision:11b" },
    ];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (!url.endsWith("/api/show")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      const body = JSON.parse(requestBodyText(init?.body)) as { name?: string };
      if (body.name === "llava:13b") {
        return jsonResponse({
          model_info: {
            "llama.context_length": 4096,
            "clip.has_vision_encoder": true,
            "clip.vision.image_size": 336,
          },
          details: { families: ["llama", "clip"] },
        });
      }
      if (body.name === "llama3.2-vision:11b") {
        return jsonResponse({
          model_info: {
            "mllama.context_length": 131072,
            "mllama.vision.image_size": 560,
          },
          details: { families: ["mllama"] },
        });
      }
      return jsonResponse({ model_info: { "llama.context_length": 8192 } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched).toEqual([
      { name: "llava:13b", contextWindow: 4096, vision: true },
      { name: "llama3:8b", contextWindow: 8192, vision: undefined },
      { name: "llama3.2-vision:11b", contextWindow: 131072, vision: true },
    ]);
  });
});

describe("detectVisionFromShowResponse", () => {
  it("detects CLIP-based vision models via model_info keys", () => {
    expect(
      detectVisionFromShowResponse({
        model_info: { "clip.has_vision_encoder": true, "clip.vision.image_size": 336 },
      }),
    ).toBe(true);
  });

  it("detects mllama vision models via model_info keys", () => {
    expect(
      detectVisionFromShowResponse({
        model_info: { "mllama.vision.image_size": 560 },
      }),
    ).toBe(true);
  });

  it("detects vision models via details.families", () => {
    expect(
      detectVisionFromShowResponse({
        details: { families: ["llama", "clip"] },
      }),
    ).toBe(true);

    expect(
      detectVisionFromShowResponse({
        details: { families: ["mllama"] },
      }),
    ).toBe(true);
  });

  it("returns false for text-only models", () => {
    expect(
      detectVisionFromShowResponse({
        model_info: { "llama.context_length": 8192, "general.architecture": "llama" },
        details: { families: ["llama"] },
      }),
    ).toBe(false);
  });

  it("returns false for empty response", () => {
    expect(detectVisionFromShowResponse({})).toBe(false);
  });
});

describe("isVisionModelHeuristic", () => {
  it.each([
    "llava:13b",
    "llava-llama3:8b",
    "bakllava:7b",
    "llama3.2-vision:11b",
    "qwen2.5-vl-7b",
    "qwen2-vl:72b",
    "moondream:latest",
    "moondream2:latest",
    "minicpm-v:8b",
    "pixtral-12b:latest",
    "internvl2:26b",
  ])("identifies %s as a vision model", (modelId) => {
    expect(isVisionModelHeuristic(modelId)).toBe(true);
  });

  it.each(["llama3:8b", "deepseek-r1:14b", "qwen3:30b-a3b", "gemma2:9b", "phi3:14b"])(
    "does not flag %s as a vision model",
    (modelId) => {
      expect(isVisionModelHeuristic(modelId)).toBe(false);
    },
  );
});

describe("buildOllamaModelDefinition", () => {
  it("sets input to text-only for plain text models", () => {
    const def = buildOllamaModelDefinition("llama3:8b");
    expect(def.input).toEqual(["text"]);
  });

  it("sets input to text+image when vision detected by API", () => {
    const def = buildOllamaModelDefinition("llama3:8b", undefined, { vision: true });
    expect(def.input).toEqual(["text", "image"]);
  });

  it("sets input to text+image via name heuristic when no API data", () => {
    const def = buildOllamaModelDefinition("llava:13b");
    expect(def.input).toEqual(["text", "image"]);
  });

  it("uses name heuristic as fallback when API did not detect vision", () => {
    // Name says vision, API returned no vision data (undefined) → heuristic wins
    const def = buildOllamaModelDefinition("qwen2.5-vl-7b", undefined, { vision: undefined });
    expect(def.input).toEqual(["text", "image"]);
  });
});
