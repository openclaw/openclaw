import type { Model } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const createAnthropicVertexStreamFnForModel = vi.hoisted(() => vi.fn());
const ensureCustomApiRegistered = vi.hoisted(() => vi.fn());
const createConfiguredOllamaStreamFn = vi.hoisted(() => vi.fn());

vi.mock("./anthropic-vertex-stream.js", () => ({
  createAnthropicVertexStreamFnForModel,
}));

vi.mock("./custom-api-registry.js", () => ({
  ensureCustomApiRegistered,
}));

vi.mock("./ollama-stream.js", () => ({
  createConfiguredOllamaStreamFn,
}));

import { prepareModelForSimpleCompletion } from "./simple-completion-transport.js";

describe("prepareModelForSimpleCompletion", () => {
  beforeEach(() => {
    createAnthropicVertexStreamFnForModel.mockReset();
    ensureCustomApiRegistered.mockReset();
    createConfiguredOllamaStreamFn.mockReset();
    createAnthropicVertexStreamFnForModel.mockReturnValue("vertex-stream");
    createConfiguredOllamaStreamFn.mockReturnValue("ollama-stream");
  });

  it("registers the configured Ollama transport and keeps the original api", () => {
    const model: Model<"ollama"> = {
      id: "llama3",
      name: "Llama 3",
      api: "ollama",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 4096,
      headers: {},
    };
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://remote-ollama:11434",
            models: [],
          },
        },
      },
    };

    const result = prepareModelForSimpleCompletion({
      model,
      cfg,
    });

    expect(createConfiguredOllamaStreamFn).toHaveBeenCalledWith({
      model,
      providerBaseUrl: "http://remote-ollama:11434",
    });
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith("ollama", "ollama-stream");
    expect(result).toBe(model);
  });

  it("uses a custom api alias for Anthropic Vertex simple completions", () => {
    const model: Model<"anthropic-messages"> = {
      id: "claude-sonnet",
      name: "Claude Sonnet",
      api: "anthropic-messages",
      provider: "anthropic-vertex",
      baseUrl: "https://us-central1-aiplatform.googleapis.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    };

    const result = prepareModelForSimpleCompletion({ model });

    expect(createAnthropicVertexStreamFnForModel).toHaveBeenCalledWith(model);
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith(
      "openclaw-anthropic-vertex-simple:https%3A%2F%2Fus-central1-aiplatform.googleapis.com",
      "vertex-stream",
    );
    expect(result).toEqual({
      ...model,
      api: "openclaw-anthropic-vertex-simple:https%3A%2F%2Fus-central1-aiplatform.googleapis.com",
    });
  });
});
