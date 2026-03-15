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
    const models: OllamaTagModel[] = [{ name: "llama3:8b" }, { name: "qwen2.5-vl:7b" }];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (!url.endsWith("/api/show")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      const body = JSON.parse(requestBodyText(init?.body)) as { name?: string };
      if (body.name === "llama3:8b") {
        return jsonResponse({
          model_info: { "llama.context_length": 65536 },
          capabilities: ["completion"],
        });
      }
      if (body.name === "qwen2.5-vl:7b") {
        return jsonResponse({ capabilities: ["completion", "vision"] });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched).toEqual([
      { name: "llama3:8b", contextWindow: 65536, input: ["text"] },
      { name: "qwen2.5-vl:7b", contextWindow: undefined, input: ["text", "image"] },
    ]);
  });
});
