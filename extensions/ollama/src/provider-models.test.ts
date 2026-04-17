import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, requestBodyText, requestUrl } from "../../../src/test-helpers/http.js";
import {
  buildOllamaModelDefinition,
  enrichOllamaModelsWithContext,
  isReasoningModelHeuristic,
  resetOllamaModelShowInfoCacheForTest,
  resolveOllamaApiBase,
  type OllamaTagModel,
} from "./provider-models.js";

describe("ollama provider models", () => {
  afterEach(() => {
    resetOllamaModelShowInfoCacheForTest();
    vi.unstubAllGlobals();
  });

  it("strips /v1 when resolving the Ollama API base", () => {
    expect(resolveOllamaApiBase("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(resolveOllamaApiBase("http://127.0.0.1:11434///")).toBe("http://127.0.0.1:11434");
  });

  it("sets discovered models with context windows from /api/show", async () => {
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
      { name: "llama3:8b", contextWindow: 65536, capabilities: undefined },
      { name: "deepseek-r1:14b", contextWindow: undefined, capabilities: undefined },
    ]);
  });

  it("sets models with vision capability from /api/show capabilities", async () => {
    const models: OllamaTagModel[] = [{ name: "kimi-k2.5:cloud" }, { name: "glm-5.1:cloud" }];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (!url.endsWith("/api/show")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      const body = JSON.parse(requestBodyText(init?.body)) as { name?: string };
      if (body.name === "kimi-k2.5:cloud") {
        return jsonResponse({
          model_info: { "kimi-k2.context_length": 262144 },
          capabilities: ["vision", "thinking", "completion", "tools"],
        });
      }
      if (body.name === "glm-5.1:cloud") {
        return jsonResponse({
          model_info: { "glm5.context_length": 202752 },
          capabilities: ["thinking", "completion", "tools"],
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched).toEqual([
      {
        name: "kimi-k2.5:cloud",
        contextWindow: 262144,
        capabilities: ["vision", "thinking", "completion", "tools"],
      },
      {
        name: "glm-5.1:cloud",
        contextWindow: 202752,
        capabilities: ["thinking", "completion", "tools"],
      },
    ]);
  });

  it("reuses cached /api/show metadata when the model digest is unchanged", async () => {
    const models: OllamaTagModel[] = [
      { name: "qwen3:32b", digest: "sha256:abc123", modified_at: "2026-04-11T00:00:00Z" },
    ];
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model_info: { "qwen3.context_length": 131072 },
        capabilities: ["thinking", "tools"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);
    const second = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes cached /api/show metadata when the model digest changes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          model_info: { "qwen3.context_length": 131072 },
          capabilities: ["thinking", "tools"],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          model_info: { "qwen3.context_length": 262144 },
          capabilities: ["vision", "thinking", "tools"],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [
      { name: "qwen3:32b", digest: "sha256:abc123" },
    ]);
    const second = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [
      { name: "qwen3:32b", digest: "sha256:def456" },
    ]);

    expect(first).toEqual([
      {
        name: "qwen3:32b",
        digest: "sha256:abc123",
        contextWindow: 131072,
        capabilities: ["thinking", "tools"],
      },
    ]);
    expect(second).toEqual([
      {
        name: "qwen3:32b",
        digest: "sha256:def456",
        contextWindow: 262144,
        capabilities: ["vision", "thinking", "tools"],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries /api/show after an empty result for the same digest", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(
        jsonResponse({
          model_info: { "qwen3.context_length": 131072 },
          capabilities: ["thinking", "tools"],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const model: OllamaTagModel = { name: "qwen3:32b", digest: "sha256:abc123" };
    const first = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [model]);
    const second = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [model]);

    expect(first).toEqual([
      {
        name: "qwen3:32b",
        digest: "sha256:abc123",
        contextWindow: undefined,
        capabilities: undefined,
      },
    ]);
    expect(second).toEqual([
      {
        name: "qwen3:32b",
        digest: "sha256:abc123",
        contextWindow: 131072,
        capabilities: ["thinking", "tools"],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("normalizes /v1 base URLs before fetching and reuses the same cache entry", async () => {
    const model: OllamaTagModel = { name: "qwen3:32b", digest: "sha256:abc123" };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(input)).toBe("http://127.0.0.1:11434/api/show");
      expect(JSON.parse(requestBodyText(init?.body))).toEqual({ name: "qwen3:32b" });
      return jsonResponse({
        model_info: { "qwen3.context_length": 131072 },
        capabilities: ["thinking", "tools"],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await enrichOllamaModelsWithContext("http://127.0.0.1:11434/v1/", [model]);
    const second = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [model]);

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("isReasoningModelHeuristic", () => {
    it.each([
      ["deepseek-r1", true],
      ["deepseek-r1:7b", true],
      ["qwen3:thinking", true],
      ["some-reasoning-model", true],
      ["model-with-think", true],
      ["my-reasoner", true],
      ["gemma4", true],
      ["gemma4:27b", true],
      ["gemma4:12b", true],
      ["gemma4:31b-q4_K_M", true],
      ["GEMMA4:27B", true],
      ["llama3:8b", false],
      ["mistral:7b", false],
      ["gemma:7b", false],
      ["gemma2:9b", false],
      ["gemma3:27b", false],
      ["codellama:13b", false],
      ["phi3:mini", false],
    ])("returns %s for %s", (modelId, expected) => {
      expect(isReasoningModelHeuristic(modelId)).toBe(expected);
    });
  });

  it("buildOllamaModelDefinition sets reasoning from thinking capability", () => {
    const withThinking = buildOllamaModelDefinition("custom-local-model", undefined, [
      "thinking",
      "tools",
    ]);
    expect(withThinking.reasoning).toBe(true);

    const withoutThinking = buildOllamaModelDefinition("custom-local-model", undefined, [
      "completion",
      "tools",
    ]);
    expect(withoutThinking.reasoning).toBe(false);
  });

  it("buildOllamaModelDefinition sets reasoning for gemma4 via heuristic", () => {
    const gemma4 = buildOllamaModelDefinition("gemma4:27b");
    expect(gemma4.reasoning).toBe(true);

    const gemma3 = buildOllamaModelDefinition("gemma3:27b");
    expect(gemma3.reasoning).toBe(false);
  });

  it("buildOllamaModelDefinition sets input to text+image when vision capability is present", () => {
    const visionModel = buildOllamaModelDefinition("kimi-k2.5:cloud", 262144, [
      "vision",
      "completion",
      "tools",
    ]);
    expect(visionModel.input).toEqual(["text", "image"]);

    const textModel = buildOllamaModelDefinition("glm-5.1:cloud", 202752, ["completion", "tools"]);
    expect(textModel.input).toEqual(["text"]);

    const noCapabilities = buildOllamaModelDefinition("unknown-model", 65536);
    expect(noCapabilities.input).toEqual(["text"]);
  });
});
