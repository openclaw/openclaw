// Test file to verify fix for issue #12740:
// Config apiKey must win over stale models.json apiKey in merge mode.
// This test FAILS on unpatched main and PASSES on the fix.

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  installModelsConfigTestHooks,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { readGeneratedModelsJson } from "./models-config.test-utils.js";

installModelsConfigTestHooks();

const MODELS_JSON_NAME = "models.json";

async function writeAgentModelsJson(content: unknown): Promise<void> {
  const agentDir = resolveOpenClawAgentDir();
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, MODELS_JSON_NAME),
    JSON.stringify(content, null, 2),
    "utf8",
  );
}

describe("models-config merge mode: config apiKey wins on update (#12740)", () => {
  it("uses updated config apiKey when existing models.json has a stale key", async () => {
    // Simulates: user had OLD_API_KEY in models.json, then changed it to
    // NEW_API_KEY via Control UI (config). The merge must use the new config
    // value — not silently preserve the stale file value, which would make
    // the config appear locked.
    await withTempHome(async () => {
      // Seed models.json with old key (simulates pre-existing state)
      await writeAgentModelsJson({
        providers: {
          custom: {
            baseUrl: "https://old.example/v1",
            apiKey: "OLD_API_KEY",
            api: "openai-responses",
            models: [
              {
                id: "old-model",
                name: "Old model",
                api: "openai-responses",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 2048,
              },
            ],
          },
        },
      });

      // Config now has the updated key (simulates user saving new key via Control UI)
      await ensureOpenClawModelsJson({
        models: {
          mode: "merge",
          providers: {
            custom: {
              baseUrl: "https://new.example/v1",
              apiKey: "NEW_API_KEY",
              api: "openai-responses",
              models: [
                {
                  id: "new-model",
                  name: "New model",
                  api: "openai-responses",
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
      });

      const parsed = await readGeneratedModelsJson<{
        providers: Record<string, { apiKey?: string; baseUrl?: string }>;
      }>();

      // The config-provided NEW_API_KEY must win over the stale OLD_API_KEY in models.json.
      // On unpatched main, this assertion fails because OLD_API_KEY is preserved.
      expect(parsed.providers.custom?.apiKey).toBe("NEW_API_KEY");
      expect(parsed.providers.custom?.baseUrl).toBe("https://new.example/v1");
    });
  });

  it("still preserves existing models.json apiKey when config does not supply one", async () => {
    // The original 9c6dc098c fix: when config has no apiKey, preserve from models.json.
    // This must still work after our change.
    await withTempHome(async () => {
      await writeAgentModelsJson({
        providers: {
          custom: {
            baseUrl: "https://agent.example/v1",
            apiKey: "AGENT_ONLY_KEY",
            api: "openai-responses",
            models: [],
          },
        },
      });

      // Config has NO apiKey for this provider (key set directly in models.json)
      await ensureOpenClawModelsJson({
        models: {
          mode: "merge",
          providers: {
            custom: {
              baseUrl: "",
              api: "openai-responses",
              models: [],
            },
          },
        },
      });

      const parsed = await readGeneratedModelsJson<{
        providers: Record<string, { apiKey?: string }>;
      }>();

      // When config doesn't provide a key, preserve the existing one.
      expect(parsed.providers.custom?.apiKey).toBe("AGENT_ONLY_KEY");
    });
  });
});
