import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("Ollama provider enhanced", () => {
  let agentDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-enhanced-"));
    // Clear all Ollama related env vars for clean state
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_BASE_URL;
    delete process.env.OLLAMA_BASE_URL;
    
    // We need to bypass the VITEST check in discoverOllamaModels if we want to test discovery
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("should use OLLAMA_API_BASE_URL from env for discovery", async () => {
    process.env.OLLAMA_API_KEY = "test-key";
    process.env.OLLAMA_API_BASE_URL = "http://custom-ollama:11434";
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "llama3" }] }),
    } as Response);

    // Temporarily unset VITEST/NODE_ENV to allow discovery
    const originalVitest = process.env.VITEST;
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(mockFetch).toHaveBeenCalledWith("http://custom-ollama:11434/api/tags", expect.anything());
      expect(providers?.ollama?.baseUrl).toBe("http://custom-ollama:11434/v1");
    } finally {
      process.env.VITEST = originalVitest;
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("should use baseUrl from config for discovery", async () => {
    process.env.OLLAMA_API_KEY = "test-key";
    const config = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://config-ollama:11434/v1",
          }
        }
      }
    };
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "llama3" }] }),
    } as Response);

    const originalVitest = process.env.VITEST;
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";

    try {
      const providers = await resolveImplicitProviders({ agentDir, config: config as any });
      expect(mockFetch).toHaveBeenCalledWith("http://config-ollama:11434/api/tags", expect.anything());
      expect(providers?.ollama?.baseUrl).toBe("http://config-ollama:11434/v1");
    } finally {
      process.env.VITEST = originalVitest;
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("should not perform discovery if models are present in config", async () => {
    process.env.OLLAMA_API_KEY = "test-key";
    const config = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://config-ollama:11434/v1",
            models: [{ id: "manual-model", name: "Manual" }]
          }
        }
      }
    };
    const mockFetch = vi.mocked(fetch);

    const providers = await resolveImplicitProviders({ agentDir, config: config as any });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(providers?.ollama).toBeUndefined();
  });
});
