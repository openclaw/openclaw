import { describe, it, expect } from "vitest";
import { discoverLocalCapabilities } from "./capabilities-discovery.js";

describe("Local Capabilities Discovery", () => {
  describe("Reasoning model detection", () => {
    it("identifies deepseek-r1 as a reasoning model", () => {
      const result = discoverLocalCapabilities({
        modelId: "deepseek-r1:32b",
        providerType: "ollama",
      });
      expect(result.isReasoningModel).toBe(true);
      expect(result.toolFormat).toBe("none"); // deepseek-r1 base doesn't natively do tools well without coder variants
    });

    it("identifies qwq as a reasoning model", () => {
      const result = discoverLocalCapabilities({
        modelId: "Qwen/QwQ-32B-Preview",
        providerType: "lmstudio",
      });
      expect(result.isReasoningModel).toBe(true);
      expect(result.toolFormat).toBe("openai"); // Qwen family includes tool support match
    });
  });

  describe("Tool format detection", () => {
    it("assigns ollama-dsl to known tool-capable Ollama models", () => {
      const result = discoverLocalCapabilities({
        modelId: "qwen2.5-coder:32b",
        providerType: "ollama",
      });
      expect(result.toolFormat).toBe("ollama-dsl");
      expect(result.isReasoningModel).toBe(false);
    });

    it("assigns openai format to known tool-capable LMStudio models", () => {
      const result = discoverLocalCapabilities({
        modelId: "llama-3.3-70b-instruct",
        providerType: "lmstudio",
      });
      expect(result.toolFormat).toBe("openai");
    });

    it("assigns none to small models like gemma:2b", () => {
      const result = discoverLocalCapabilities({ modelId: "gemma:2b", providerType: "ollama" });
      expect(result.toolFormat).toBe("none");
    });

    it("assigns none to unknown standard models", () => {
      const result = discoverLocalCapabilities({ modelId: "wizardlm2", providerType: "ollama" });
      expect(result.toolFormat).toBe("none");
    });
  });
});
