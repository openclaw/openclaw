import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { resolveImplicitProviders, resolveOllamaApiBase } from "./models-config.providers.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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

  it("discovers per-model context windows from /api/show", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_API_KEY = "test-key";
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          json: async () => ({
            models: [
              { name: "qwen3:32b", modified_at: "", size: 1, digest: "" },
              { name: "llama3.3:70b", modified_at: "", size: 1, digest: "" },
            ],
          }),
        };
      }
      if (url.endsWith("/api/show")) {
        const rawBody = init?.body;
        const bodyText = typeof rawBody === "string" ? rawBody : "{}";
        const parsed = JSON.parse(bodyText) as { name?: string };
        if (parsed.name === "qwen3:32b") {
          return {
            ok: true,
            json: async () => ({ model_info: { "qwen3.context_length": 131072 } }),
          };
        }
        if (parsed.name === "llama3.3:70b") {
          return {
            ok: true,
            json: async () => ({ model_info: { "llama.context_length": 65536 } }),
          };
        }
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      const models = providers?.ollama?.models ?? [];
      const qwen = models.find((model) => model.id === "qwen3:32b");
      const llama = models.find((model) => model.id === "llama3.3:70b");
      expect(qwen?.contextWindow).toBe(131072);
      expect(llama?.contextWindow).toBe(65536);
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.filter((url) => url.endsWith("/api/tags"))).toHaveLength(1);
      expect(urls.filter((url) => url.endsWith("/api/show"))).toHaveLength(2);
    } finally {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("falls back to default context window when /api/show fails", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_API_KEY = "test-key";
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          json: async () => ({
            models: [{ name: "qwen3:32b", modified_at: "", size: 1, digest: "" }],
          }),
        };
      }
      if (url.endsWith("/api/show")) {
        return {
          ok: false,
          status: 500,
        };
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      const model = providers?.ollama?.models?.find((entry) => entry.id === "qwen3:32b");
      expect(model?.contextWindow).toBe(128000);
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.filter((url) => url.endsWith("/api/tags"))).toHaveLength(1);
      expect(urls.filter((url) => url.endsWith("/api/show"))).toHaveLength(1);
    } finally {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("caps /api/show requests when /api/tags returns a very large model list", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_API_KEY = "test-key";
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    const manyModels = Array.from({ length: 250 }, (_, idx) => ({
      name: `model-${idx}`,
      modified_at: "",
      size: 1,
      digest: "",
    }));
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: manyModels }),
        };
      }
      return {
        ok: true,
        json: async () => ({ model_info: { "llama.context_length": 65536 } }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      const models = providers?.ollama?.models ?? [];
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      // 1 call for /api/tags + 200 capped /api/show calls.
      expect(urls.filter((url) => url.endsWith("/api/tags"))).toHaveLength(1);
      expect(urls.filter((url) => url.endsWith("/api/show"))).toHaveLength(200);
      expect(models).toHaveLength(200);
    } finally {
      delete process.env.OLLAMA_API_KEY;
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

  it("should skip discovery fetch when explicit models are configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const explicitModels: ModelDefinitionConfig[] = [
      {
        id: "gpt-oss:20b",
        name: "GPT-OSS 20B",
        reasoning: false,
        input: ["text"] as Array<"text" | "image">,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 81920,
      },
    ];

    const providers = await resolveImplicitProviders({
      agentDir,
      explicitProviders: {
        ollama: {
          baseUrl: "http://remote-ollama:11434/v1",
          models: explicitModels,
          apiKey: "config-ollama-key",
        },
      },
    });

    const ollamaCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = String(input);
      return url.endsWith("/api/tags") || url.endsWith("/api/show");
    });
    expect(ollamaCalls).toHaveLength(0);
    expect(providers?.ollama?.models).toEqual(explicitModels);
    expect(providers?.ollama?.baseUrl).toBe("http://remote-ollama:11434");
    expect(providers?.ollama?.api).toBe("ollama");
    expect(providers?.ollama?.apiKey).toBe("config-ollama-key");
  });

  it("should preserve explicit apiKey when discovery path has no models and no env key", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));

    const providers = await resolveImplicitProviders({
      agentDir,
      explicitProviders: {
        ollama: {
          baseUrl: "http://remote-ollama:11434/v1",
          api: "openai-completions",
          models: [],
          apiKey: "config-ollama-key",
        },
      },
    });

    expect(providers?.ollama?.apiKey).toBe("config-ollama-key");
  });
});
