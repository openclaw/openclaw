import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-vault-proxy-" });
}

const VAULT_CFG: OpenClawConfig = {
  vault: {
    enabled: true,
    proxies: {
      openai: "http://vault:8081",
      anthropic: "http://vault:8082",
    },
  },
  models: {
    mode: "replace",
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-real-key",
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
      },
      ollama: {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "ollama-local",
        api: "openai-completions",
        models: [
          {
            id: "llama3",
            name: "Llama 3",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
};

describe("models-config vault proxy", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("rewrites baseUrl and apiKey for vault-proxied providers", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureOpenClawModelsJson } = await import("./models-config.js");

      const { agentDir, wrote } = await ensureOpenClawModelsJson(VAULT_CFG);
      expect(wrote).toBe(true);

      const modelsPath = path.join(agentDir, "models.json");
      const raw = await fs.readFile(modelsPath, "utf8");
      const data = JSON.parse(raw) as {
        providers: Record<string, { baseUrl: string; apiKey?: string }>;
      };

      // openai: vault-proxied, baseUrl and apiKey rewritten
      expect(data.providers.openai.baseUrl).toBe("http://vault:8081");
      expect(data.providers.openai.apiKey).toBe("vault-proxy-managed");

      // ollama: NOT vault-proxied, baseUrl and apiKey unchanged
      expect(data.providers.ollama.baseUrl).toBe("http://localhost:11434/v1");
      expect(data.providers.ollama.apiKey).toBe("ollama-local");
    });
  });

  it("does not rewrite when vault is disabled", async () => {
    const cfg: OpenClawConfig = {
      ...VAULT_CFG,
      vault: { ...VAULT_CFG.vault, enabled: false },
    };

    await withTempHome(async () => {
      vi.resetModules();
      const { ensureOpenClawModelsJson } = await import("./models-config.js");

      const { agentDir, wrote } = await ensureOpenClawModelsJson(cfg);
      expect(wrote).toBe(true);

      const modelsPath = path.join(agentDir, "models.json");
      const raw = await fs.readFile(modelsPath, "utf8");
      const data = JSON.parse(raw) as {
        providers: Record<string, { baseUrl: string; apiKey?: string }>;
      };

      // Original baseUrl preserved
      expect(data.providers.openai.baseUrl).toBe("https://api.openai.com/v1");
    });
  });
});
