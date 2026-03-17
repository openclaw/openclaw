import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, requestBodyText, requestUrl } from "../test-helpers/http.js";
import {
  enrichOllamaModelsWithContext,
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
      { name: "llama3:8b", contextWindow: 65536 },
      { name: "deepseek-r1:14b", contextWindow: undefined },
    ]);
  });
});

// ── manusilized: isReasoningModelHeuristic extended tests ────────────────────
import { isReasoningModelHeuristic } from "./ollama-models.js";

describe("isReasoningModelHeuristic (manusilized extended patterns)", () => {
  // Original patterns – must still pass
  it("recognises original r1 pattern", () => {
    expect(isReasoningModelHeuristic("deepseek-r1:14b")).toBe(true);
  });
  it("recognises original think pattern", () => {
    expect(isReasoningModelHeuristic("qwen2.5-think:32b")).toBe(true);
  });

  // New patterns added by manusilized
  it("recognises qwen3 series", () => {
    expect(isReasoningModelHeuristic("qwen3:32b")).toBe(true);
    expect(isReasoningModelHeuristic("qwen3-coder:480b")).toBe(true);
  });
  it("recognises qwq family", () => {
    expect(isReasoningModelHeuristic("qwq:32b-preview")).toBe(true);
  });
  it("recognises glm-5 variants", () => {
    expect(isReasoningModelHeuristic("glm-5:latest")).toBe(true);
    expect(isReasoningModelHeuristic("glm5:744b")).toBe(true);
  });
  it("recognises kimi-k2 variants", () => {
    expect(isReasoningModelHeuristic("kimi-k2.5:latest")).toBe(true);
    expect(isReasoningModelHeuristic("kimi-k2:1t")).toBe(true);
  });
  it("recognises deepseek-v3 series", () => {
    expect(isReasoningModelHeuristic("deepseek-v3.2:latest")).toBe(true);
    expect(isReasoningModelHeuristic("deepseek-v3:671b")).toBe(true);
  });
  it("recognises marco-o1", () => {
    expect(isReasoningModelHeuristic("marco-o1:latest")).toBe(true);
  });
  it("recognises skywork-o series", () => {
    expect(isReasoningModelHeuristic("skywork-o1:latest")).toBe(true);
  });

  // Non-reasoning models – must return false
  it("does not flag plain llama3 as reasoning", () => {
    expect(isReasoningModelHeuristic("llama3.3:70b")).toBe(false);
  });
  it("does not flag qwen2.5 (non-thinking) as reasoning", () => {
    expect(isReasoningModelHeuristic("qwen2.5:7b")).toBe(false);
  });
  it("does not flag gemma2 as reasoning", () => {
    expect(isReasoningModelHeuristic("gemma2:9b")).toBe(false);
  });
});
