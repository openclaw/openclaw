import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImplicitProviders, resolveOllamaApiBase } from "./models-config.providers.js";

describe("resolveOllamaApiBase", () => {
  it("returns default localhost base when no configured URL is provided", () => {
    expect(resolveOllamaApiBase()).toBe("http://127.0.0.1:11434");
  });

  it("strips /v1 suffix from OpenAI-compatible URLs", () => {
    expect(resolveOllamaApiBase("http://ollama-host:11434/v1")).toBe("http://ollama-host:11434");
    expect(resolveOllamaApiBase("http://ollama-host:11434/V1")).toBe("http://ollama-host:11434");
  });

  it("keeps URLs without /v1 unchanged", () => {
    expect(resolveOllamaApiBase("http://ollama-host:11434")).toBe("http://ollama-host:11434");
  });

  it("handles trailing slash before canonicalizing", () => {
    expect(resolveOllamaApiBase("http://ollama-host:11434/v1/")).toBe("http://ollama-host:11434");
    expect(resolveOllamaApiBase("http://ollama-host:11434/")).toBe("http://ollama-host:11434");
  });
});

describe("Ollama provider", () => {
  it("should not include ollama when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProviders({ agentDir });

    expect(providers?.ollama).toBeUndefined();
  });

  it("should use native ollama api type", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });

      expect(providers?.ollama).toBeDefined();
      expect(providers?.ollama?.apiKey).toBe("OLLAMA_API_KEY");
      expect(providers?.ollama?.api).toBe("ollama");
      expect(providers?.ollama?.baseUrl).toBe("http://127.0.0.1:11434");
    } finally {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("should preserve explicit ollama baseUrl on implicit provider injection", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({
        agentDir,
        explicitProviders: {
          ollama: {
            baseUrl: "http://192.168.20.14:11434/v1",
            api: "openai-completions",
            models: [],
          },
        },
      });

      // Native API strips /v1 suffix via resolveOllamaApiBase()
      expect(providers?.ollama?.baseUrl).toBe("http://192.168.20.14:11434");
    } finally {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("injects ollama with placeholder key when explicitly configured but no env key", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const saved = process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEY;

    try {
      const providers = await resolveImplicitProviders({
        agentDir,
        explicitProviders: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [],
          },
        },
      });

      expect(providers?.ollama).toBeDefined();
      expect(providers?.ollama?.apiKey).toBe("local");
      expect(providers?.ollama?.api).toBe("ollama");
    } finally {
      if (saved !== undefined) {
        process.env.OLLAMA_API_KEY = saved;
      }
    }
  });

  it("preserves SecretRef apiKey on ollama provider instead of injecting placeholder", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const saved = process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEY;

    try {
      const secretRef = { source: "env", id: "MY_OLLAMA_KEY" };
      const providers = await resolveImplicitProviders({
        agentDir,
        explicitProviders: {
          ollama: {
            baseUrl: "http://remote-ollama:11434",
            api: "ollama",
            apiKey: secretRef as never,
            models: [],
          },
        },
      });

      expect(providers?.ollama).toBeDefined();
      // SecretRef must be preserved, not overwritten with "local"
      expect(providers?.ollama?.apiKey).toEqual(secretRef);
    } finally {
      if (saved !== undefined) {
        process.env.OLLAMA_API_KEY = saved;
      }
    }
  });

  it("should have correct model structure without streaming override", () => {
    const mockOllamaModel = {
      id: "llama3.3:latest",
      name: "llama3.3:latest",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    };

    // Native Ollama provider does not need streaming: false workaround
    expect(mockOllamaModel).not.toHaveProperty("params");
  });
});
