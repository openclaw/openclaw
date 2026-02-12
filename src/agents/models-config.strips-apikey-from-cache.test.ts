import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-models-" });
}

describe("models-config apiKey stripping (#14808)", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("does not write apiKey to models.json for explicitly configured providers", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureOpenClawModelsJson } = await import("./models-config.js");
      const { resolveOpenClawAgentDir } = await import("./agent-paths.js");

      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "custom-provider": {
              baseUrl: "https://api.example.com/v1",
              apiKey: "sk-secret-plaintext-key-12345",
              api: "openai-completions",
              models: [
                {
                  id: "test-model",
                  name: "Test Model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { apiKey?: string; baseUrl?: string }>;
      };

      // The provider should be written but without the apiKey
      expect(parsed.providers["custom-provider"]).toBeDefined();
      expect(parsed.providers["custom-provider"]?.baseUrl).toBe("https://api.example.com/v1");
      expect(parsed.providers["custom-provider"]?.apiKey).toBeUndefined();

      // Also verify the raw JSON does not contain the secret
      expect(raw).not.toContain("sk-secret-plaintext-key-12345");
    });
  });

  it("does not write resolved env var apiKey to models.json", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const prevKey = process.env.MINIMAX_API_KEY;
      process.env.MINIMAX_API_KEY = "sk-minimax-secret-value";
      try {
        const { ensureOpenClawModelsJson } = await import("./models-config.js");
        const { resolveOpenClawAgentDir } = await import("./agent-paths.js");

        await ensureOpenClawModelsJson({});

        const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
        const raw = await fs.readFile(modelPath, "utf8");

        // The secret value must never appear in the cache file
        expect(raw).not.toContain("sk-minimax-secret-value");
        // The env var name must not appear either (apiKey stripped entirely)
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { apiKey?: string }>;
        };
        expect(parsed.providers.minimax?.apiKey).toBeUndefined();
      } finally {
        if (prevKey === undefined) {
          delete process.env.MINIMAX_API_KEY;
        } else {
          process.env.MINIMAX_API_KEY = prevKey;
        }
      }
    });
  });

  it("does not write apiKey for ${VAR} syntax that was resolved at config load time", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureOpenClawModelsJson } = await import("./models-config.js");
      const { resolveOpenClawAgentDir } = await import("./agent-paths.js");

      // Simulate a config where ${VAR} was already resolved to plaintext by
      // resolveConfigEnvVars (the bug scenario from #14808)
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              apiKey: "sk-ant-api03-RESOLVED-SECRET-VALUE",
              api: "anthropic-messages",
              models: [
                {
                  id: "claude-sonnet-4-20250514",
                  name: "Claude Sonnet 4",
                  reasoning: false,
                  input: ["text", "image"],
                  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                  contextWindow: 200000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");

      // The resolved secret must never appear on disk
      expect(raw).not.toContain("sk-ant-api03-RESOLVED-SECRET-VALUE");
      expect(raw).not.toContain("apiKey");

      // Model metadata should still be present
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { models?: Array<{ id: string }>; apiKey?: string }>;
      };
      expect(parsed.providers.anthropic?.apiKey).toBeUndefined();
      expect(parsed.providers.anthropic?.models?.[0]?.id).toBe("claude-sonnet-4-20250514");
    });
  });

  it("strips apiKey from pre-existing models.json entries during merge", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureOpenClawModelsJson } = await import("./models-config.js");
      const { resolveOpenClawAgentDir } = await import("./agent-paths.js");

      const agentDir = resolveOpenClawAgentDir();
      await fs.mkdir(agentDir, { recursive: true });

      // Simulate a pre-existing models.json that contains an apiKey (from
      // before the fix was applied)
      await fs.writeFile(
        path.join(agentDir, "models.json"),
        JSON.stringify(
          {
            providers: {
              "legacy-provider": {
                baseUrl: "http://localhost:9000/v1",
                apiKey: "sk-leaked-legacy-key",
                api: "openai-completions",
                models: [
                  {
                    id: "legacy-model",
                    name: "Legacy",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 2048,
                  },
                ],
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      // Write with a new provider — the merge should also strip legacy apiKeys
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "new-provider": {
              baseUrl: "https://api.new.com/v1",
              apiKey: "sk-new-secret",
              api: "openai-completions",
              models: [
                {
                  id: "new-model",
                  name: "New",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 2048,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
      expect(raw).not.toContain("sk-leaked-legacy-key");
      expect(raw).not.toContain("sk-new-secret");
      expect(raw).not.toContain("apiKey");
    });
  });

  it("preserves all non-credential provider fields in the cache", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureOpenClawModelsJson } = await import("./models-config.js");
      const { resolveOpenClawAgentDir } = await import("./agent-paths.js");

      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "full-provider": {
              baseUrl: "https://api.full.com/v1",
              apiKey: "sk-should-be-stripped",
              api: "openai-completions",
              models: [
                {
                  id: "full-model",
                  name: "Full Model",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 5, output: 10, cacheRead: 1, cacheWrite: 2 },
                  contextWindow: 200000,
                  maxTokens: 16384,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<
          string,
          {
            baseUrl?: string;
            api?: string;
            apiKey?: string;
            models?: Array<{
              id: string;
              name: string;
              reasoning: boolean;
              input: string[];
              cost: { input: number; output: number };
              contextWindow: number;
              maxTokens: number;
            }>;
          }
        >;
      };

      const provider = parsed.providers["full-provider"];
      expect(provider).toBeDefined();
      expect(provider?.apiKey).toBeUndefined();
      expect(provider?.baseUrl).toBe("https://api.full.com/v1");
      expect(provider?.api).toBe("openai-completions");
      expect(provider?.models?.[0]?.id).toBe("full-model");
      expect(provider?.models?.[0]?.name).toBe("Full Model");
      expect(provider?.models?.[0]?.reasoning).toBe(true);
      expect(provider?.models?.[0]?.input).toEqual(["text", "image"]);
      expect(provider?.models?.[0]?.cost.input).toBe(5);
      expect(provider?.models?.[0]?.contextWindow).toBe(200000);
      expect(provider?.models?.[0]?.maxTokens).toBe(16384);
    });
  });
});
