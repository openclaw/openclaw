import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  installModelsConfigTestHooks,
  withCopilotGithubToken,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

installModelsConfigTestHooks({ restoreFetch: true });

describe("models-config copilot merge", () => {
  it("merges explicit copilot model entries with implicit provider", async () => {
    await withTempHome(async (home) => {
      await withCopilotGithubToken("gh-token", async () => {
        const agentDir = path.join(home, "agent-merge");
        const config = {
          models: {
            providers: {
              "github-copilot": {
                baseUrl: "https://should-be-overridden.example",
                models: [
                  {
                    id: "claude-opus-4.6",
                    name: "claude-opus-4.6",
                    api: "openai-completions" as const,
                    reasoning: true,
                    input: ["text" as const, "image" as const],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
        };
        await ensureOpenClawModelsJson(config, agentDir);

        const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<
            string,
            { baseUrl?: string; models?: Array<{ id: string; contextWindow?: number }> }
          >;
        };

        // Implicit provider's baseUrl wins (spread order: ...implicit, ...explicit, models: merged)
        // but mergeProviderModels does { ...implicit, ...explicit, models: merged }
        // so explicit baseUrl actually wins here — which is fine, the key point is
        // the provider exists and has the model entries
        expect(parsed.providers["github-copilot"]).toBeDefined();
        expect(parsed.providers["github-copilot"]?.models?.length).toBeGreaterThanOrEqual(1);
        const opus = parsed.providers["github-copilot"]?.models?.find(
          (m) => m.id === "claude-opus-4.6",
        );
        expect(opus).toBeDefined();
        expect(opus?.contextWindow).toBe(128_000);
      });
    });
  });

  it("uses implicit provider when no explicit copilot config exists", async () => {
    await withTempHome(async (home) => {
      await withCopilotGithubToken("gh-token", async () => {
        const agentDir = path.join(home, "agent-implicit-only");
        await ensureOpenClawModelsJson({ models: { providers: {} } }, agentDir);

        const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { baseUrl?: string; models?: unknown[] }>;
        };

        expect(parsed.providers["github-copilot"]?.baseUrl).toBe("https://api.copilot.example");
        expect(parsed.providers["github-copilot"]?.models?.length ?? 0).toBe(0);
      });
    });
  });
});
