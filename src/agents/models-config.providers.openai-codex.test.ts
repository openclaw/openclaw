import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
  withModelsTempHome,
  withTempEnv,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { resolveImplicitProviders } from "./models-config.providers.js";
import { readGeneratedModelsJson } from "./models-config.test-utils.js";

installModelsConfigTestHooks();

async function writeCodexOauthProfile(agentDir: string) {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    JSON.stringify(
      {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
        order: {
          "openai-codex": ["openai-codex:default"],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("openai-codex implicit provider", () => {
  it("injects an implicit provider when Codex OAuth exists", async () => {
    await withModelsTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
        const agentDir = resolveOpenClawAgentDir();
        await writeCodexOauthProfile(agentDir);

        const providers = await resolveImplicitProviders({ agentDir });
        expect(providers?.["openai-codex"]).toMatchObject({
          baseUrl: "https://chatgpt.com/backend-api",
          api: "openai-codex-responses",
          models: [],
        });
      });
    });
  });

  it("replaces stale openai-codex baseUrl in generated models.json", async () => {
    await withModelsTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
        const agentDir = resolveOpenClawAgentDir();
        await writeCodexOauthProfile(agentDir);
        await fs.writeFile(
          path.join(agentDir, "models.json"),
          JSON.stringify(
            {
              providers: {
                "openai-codex": {
                  baseUrl: "https://api.openai.com/v1",
                  api: "openai-responses",
                  models: [
                    {
                      id: "gpt-5.4",
                      name: "GPT-5.4",
                      api: "openai-responses",
                      contextWindow: 1_000_000,
                      maxTokens: 100_000,
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

        await ensureOpenClawModelsJson({});

        const parsed = await readGeneratedModelsJson<{
          providers: Record<string, { baseUrl?: string; api?: string }>;
        }>();
        expect(parsed.providers["openai-codex"]).toMatchObject({
          baseUrl: "https://chatgpt.com/backend-api",
          api: "openai-codex-responses",
        });
      });
    });
  });
});
