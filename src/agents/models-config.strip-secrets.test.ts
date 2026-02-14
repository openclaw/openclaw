import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { ensureOpenClawModelsJson, REDACTED_PLACEHOLDER } from "./models-config.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-strip-secrets-" });
}

describe("models-config secret stripping", () => {
  it("replaces apiKey with REDACTED_BY_OPENCLAW in models.json output", async () => {
    await withTempHome(async () => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "test-provider": {
              baseUrl: "https://api.example.com",
              apiKey: "sk-secret-literal-key-12345",
              api: "openai-responses",
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
        providers: Record<string, { apiKey?: string; baseUrl?: string; models?: unknown[] }>;
      };

      expect(parsed.providers["test-provider"]?.apiKey).toBe(REDACTED_PLACEHOLDER);
      expect(raw).not.toContain("sk-secret-literal-key-12345");

      // Non-secret fields preserved
      expect(parsed.providers["test-provider"]?.baseUrl).toBe("https://api.example.com");
      expect(parsed.providers["test-provider"]?.models).toHaveLength(1);
    });
  });

  it("strips apiKey from multiple providers", async () => {
    await withTempHome(async () => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "provider-a": {
              baseUrl: "https://api.a.com",
              apiKey: "sk-secret-a",
              api: "anthropic-messages",
              models: [
                {
                  id: "model-a",
                  name: "Model A",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 15, output: 75, cacheRead: 2, cacheWrite: 4 },
                  contextWindow: 200000,
                  maxTokens: 32000,
                },
              ],
            },
            "provider-b": {
              baseUrl: "https://api.b.com",
              apiKey: "sk-secret-b",
              api: "openai-responses",
              models: [
                {
                  id: "model-b",
                  name: "Model B",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 5, output: 15, cacheRead: 1, cacheWrite: 2 },
                  contextWindow: 128000,
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
        providers: Record<string, { apiKey?: string }>;
      };

      expect(parsed.providers["provider-a"]?.apiKey).toBe(REDACTED_PLACEHOLDER);
      expect(parsed.providers["provider-b"]?.apiKey).toBe(REDACTED_PLACEHOLDER);
      expect(raw).not.toContain("sk-secret-a");
      expect(raw).not.toContain("sk-secret-b");
    });
  });

  it("does not add apiKey when provider has none", async () => {
    await withTempHome(async () => {
      const agentDir = resolveOpenClawAgentDir();
      // Pre-seed models.json so ensureOpenClawModelsJson has something to merge with
      // and doesn't skip due to empty providers.
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "no-key-provider": {
              baseUrl: "https://api.example.com",
              api: "openai-responses",
              models: [
                {
                  id: "test-model",
                  name: "Test",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const modelPath = path.join(agentDir, "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { apiKey?: string }>;
      };

      // Provider without apiKey should not get one added
      expect(parsed.providers["no-key-provider"]?.apiKey).toBeUndefined();
    });
  });
});
