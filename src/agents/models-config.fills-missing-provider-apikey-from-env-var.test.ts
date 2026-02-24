import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { validateConfigObject } from "../config/validation.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  installModelsConfigTestHooks,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { readGeneratedModelsJson } from "./models-config.test-utils.js";

installModelsConfigTestHooks();

describe("models-config", () => {
  it("keeps anthropic api defaults when model entries omit api", async () => {
    await withTempHome(async () => {
      const validated = validateConfigObject({
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://relay.example.com/api",
              apiKey: "cr_xxxx",
              models: [{ id: "claude-opus-4-6", name: "Claude Opus 4.6" }],
            },
          },
        },
      });
      expect(validated.ok).toBe(true);
      if (!validated.ok) {
        throw new Error("expected config to validate");
      }

      await ensureOpenClawModelsJson(validated.config);

      const parsed = await readGeneratedModelsJson<{
        providers: Record<string, { api?: string; models?: Array<{ id: string; api?: string }> }>;
      }>();

      expect(parsed.providers.anthropic?.api).toBe("anthropic-messages");
      expect(parsed.providers.anthropic?.models?.[0]?.api).toBe("anthropic-messages");
    });
  });

  it("fills missing provider.apiKey from env var name when models exist", async () => {
    await withTempHome(async () => {
      const prevKey = process.env.MINIMAX_API_KEY;
      process.env.MINIMAX_API_KEY = "sk-minimax-test";
      try {
        const cfg: OpenClawConfig = {
          models: {
            providers: {
              minimax: {
                baseUrl: "https://api.minimax.io/anthropic",
                api: "anthropic-messages",
                models: [
                  {
                    id: "MiniMax-M2.1",
                    name: "MiniMax M2.1",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 200000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
        };

        await ensureOpenClawModelsJson(cfg);

        const parsed = await readGeneratedModelsJson<{
          providers: Record<string, { apiKey?: string; models?: Array<{ id: string }> }>;
        }>();
        expect(parsed.providers.minimax?.apiKey).toBe("MINIMAX_API_KEY");
        const ids = parsed.providers.minimax?.models?.map((model) => model.id);
        expect(ids).toContain("MiniMax-VL-01");
      } finally {
        if (prevKey === undefined) {
          delete process.env.MINIMAX_API_KEY;
        } else {
          process.env.MINIMAX_API_KEY = prevKey;
        }
      }
    });
  });
  it("merges providers by default", async () => {
    await withTempHome(async () => {
      const agentDir = resolveOpenClawAgentDir();
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "models.json"),
        JSON.stringify(
          {
            providers: {
              existing: {
                baseUrl: "http://localhost:1234/v1",
                apiKey: "EXISTING_KEY",
                api: "openai-completions",
                models: [
                  {
                    id: "existing-model",
                    name: "Existing",
                    api: "openai-completions",
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

      await ensureOpenClawModelsJson(CUSTOM_PROXY_MODELS_CONFIG);

      const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { baseUrl?: string }>;
      };

      expect(parsed.providers.existing?.baseUrl).toBe("http://localhost:1234/v1");
      expect(parsed.providers["custom-proxy"]?.baseUrl).toBe("http://localhost:4000/v1");
    });
  });

  it("refreshes stale explicit moonshot model capabilities from implicit catalog", async () => {
    await withTempHome(async () => {
      const prevKey = process.env.MOONSHOT_API_KEY;
      process.env.MOONSHOT_API_KEY = "sk-moonshot-test";
      try {
        const cfg: OpenClawConfig = {
          models: {
            providers: {
              moonshot: {
                baseUrl: "https://api.moonshot.ai/v1",
                api: "openai-completions",
                models: [
                  {
                    id: "kimi-k2.5",
                    name: "Kimi K2.5",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 123, output: 456, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 1024,
                    maxTokens: 256,
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
              models?: Array<{
                id: string;
                input?: string[];
                reasoning?: boolean;
                contextWindow?: number;
                maxTokens?: number;
                cost?: { input?: number; output?: number };
              }>;
            }
          >;
        };
        const kimi = parsed.providers.moonshot?.models?.find((model) => model.id === "kimi-k2.5");
        expect(kimi?.input).toEqual(["text", "image"]);
        expect(kimi?.reasoning).toBe(false);
        expect(kimi?.contextWindow).toBe(256000);
        expect(kimi?.maxTokens).toBe(8192);
        // Preserve explicit user pricing overrides when refreshing capabilities.
        expect(kimi?.cost?.input).toBe(123);
        expect(kimi?.cost?.output).toBe(456);
      } finally {
        if (prevKey === undefined) {
          delete process.env.MOONSHOT_API_KEY;
        } else {
          process.env.MOONSHOT_API_KEY = prevKey;
        }
      }
    });
  });
});
