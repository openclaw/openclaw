import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ProviderConfig } from "./models-config.providers.js";
import { VAULT_PROXY_PLACEHOLDER_KEY } from "./model-auth.js";

/**
 * Isolated unit tests for normalizeProviders() vault proxy branch.
 *
 * These test the vault-specific logic in normalizeProviders() directly,
 * without going through the full ensureOpenClawModelsJson pipeline.
 */
describe("normalizeProviders vault branch (isolated)", () => {
  let tempDir: string;
  let previousHome: string | undefined;
  let previousStateDir: string | undefined;
  let previousAgentDir: string | undefined;
  let previousPiAgentDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-vault-norm-"));
    previousHome = process.env.HOME;
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;

    process.env.HOME = tempDir;
    process.env.OPENCLAW_STATE_DIR = path.join(tempDir, ".openclaw");
    process.env.OPENCLAW_AGENT_DIR = path.join(tempDir, ".openclaw", "agents", "main");
    process.env.PI_CODING_AGENT_DIR = process.env.OPENCLAW_AGENT_DIR;
    await fs.mkdir(process.env.OPENCLAW_AGENT_DIR, { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = previousHome;
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousAgentDir === undefined) {
      delete process.env.OPENCLAW_AGENT_DIR;
    } else {
      process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
    }
    if (previousPiAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-original-key",
      api: "openai-completions",
      models: [
        {
          id: "gpt-4o",
          name: "GPT-4o",
          reasoning: false,
          input: ["text"],
          cost: { input: 5, output: 15, cacheRead: 2, cacheWrite: 5 },
          contextWindow: 128000,
          maxTokens: 4096,
        },
      ],
      ...overrides,
    };
  }

  it("rewrites baseUrl and apiKey when vault proxy is active", async () => {
    vi.resetModules();
    const { normalizeProviders } = await import("./models-config.providers.js");

    const cfg: OpenClawConfig = {
      vault: { enabled: true, proxies: { openai: "http://vault:8081" } },
    };

    const result = normalizeProviders({
      providers: { openai: makeProvider() },
      agentDir: process.env.OPENCLAW_AGENT_DIR!,
      config: cfg,
    });

    expect(result!.openai.baseUrl).toBe("http://vault:8081");
    expect(result!.openai.apiKey).toBe(VAULT_PROXY_PLACEHOLDER_KEY);
  });

  it("does not rewrite when vault is disabled", async () => {
    vi.resetModules();
    const { normalizeProviders } = await import("./models-config.providers.js");

    const cfg: OpenClawConfig = {
      vault: { enabled: false, proxies: { openai: "http://vault:8081" } },
    };

    const result = normalizeProviders({
      providers: { openai: makeProvider() },
      agentDir: process.env.OPENCLAW_AGENT_DIR!,
      config: cfg,
    });

    expect(result!.openai.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("does not rewrite when config is undefined", async () => {
    vi.resetModules();
    const { normalizeProviders } = await import("./models-config.providers.js");

    const result = normalizeProviders({
      providers: { openai: makeProvider() },
      agentDir: process.env.OPENCLAW_AGENT_DIR!,
      config: undefined,
    });

    expect(result!.openai.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("skips apiKey normalization when vault proxy is active", async () => {
    vi.resetModules();
    const { normalizeProviders } = await import("./models-config.providers.js");

    const cfg: OpenClawConfig = {
      vault: { enabled: true, proxies: { openai: "http://vault:8081" } },
    };

    // apiKey in ${ENV_VAR} format would normally be normalized to ENV_VAR.
    // With vault proxy active, normalization should be skipped.
    const result = normalizeProviders({
      providers: { openai: makeProvider({ apiKey: "${OPENAI_API_KEY}" }) },
      agentDir: process.env.OPENCLAW_AGENT_DIR!,
      config: cfg,
    });

    expect(result!.openai.apiKey).toBe(VAULT_PROXY_PLACEHOLDER_KEY);
  });

  it("skips env var apiKey fill when vault proxy is active", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = "sk-from-env";

      vi.resetModules();
      const { normalizeProviders } = await import("./models-config.providers.js");

      const cfg: OpenClawConfig = {
        vault: { enabled: true, proxies: { openai: "http://vault:8081" } },
      };

      // Provider has models but no apiKey -- normally would auto-fill from env.
      // With vault proxy, should get placeholder instead.
      const result = normalizeProviders({
        providers: { openai: makeProvider({ apiKey: undefined }) },
        agentDir: process.env.OPENCLAW_AGENT_DIR!,
        config: cfg,
      });

      expect(result!.openai.apiKey).toBe(VAULT_PROXY_PLACEHOLDER_KEY);
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousKey;
      }
    }
  });

  it("handles mixed providers: some vaulted, some not", async () => {
    vi.resetModules();
    const { normalizeProviders } = await import("./models-config.providers.js");

    const cfg: OpenClawConfig = {
      vault: { enabled: true, proxies: { openai: "http://vault:8081" } },
    };

    const result = normalizeProviders({
      providers: {
        openai: makeProvider(),
        ollama: makeProvider({ baseUrl: "http://localhost:11434/v1", apiKey: "ollama" }),
      },
      agentDir: process.env.OPENCLAW_AGENT_DIR!,
      config: cfg,
    });

    // openai: vaulted
    expect(result!.openai.baseUrl).toBe("http://vault:8081");
    expect(result!.openai.apiKey).toBe(VAULT_PROXY_PLACEHOLDER_KEY);

    // ollama: not vaulted, original values preserved
    expect(result!.ollama.baseUrl).toBe("http://localhost:11434/v1");
    expect(result!.ollama.apiKey).toBe("ollama");
  });

  it("does not leak original apiKey into output when vault proxy active", async () => {
    vi.resetModules();
    const { normalizeProviders } = await import("./models-config.providers.js");

    const cfg: OpenClawConfig = {
      vault: { enabled: true, proxies: { openai: "http://vault:8081" } },
    };

    const originalKey = "sk-super-secret-key-do-not-leak";
    const result = normalizeProviders({
      providers: { openai: makeProvider({ apiKey: originalKey }) },
      agentDir: process.env.OPENCLAW_AGENT_DIR!,
      config: cfg,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(originalKey);
    expect(result!.openai.apiKey).toBe(VAULT_PROXY_PLACEHOLDER_KEY);
  });
});
