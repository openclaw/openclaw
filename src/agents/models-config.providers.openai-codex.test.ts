import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
  withModelsTempHome,
  withTempEnv,
} from "./models-config.e2e-harness.js";
import { planOpenClawModelsJson } from "./models-config.plan.js";

vi.mock("./cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
}));

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
  it("normalizes generated openai-codex rows back to the Codex transport when oauth exists", async () => {
    await withModelsTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
        process.env.OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS = "openai-codex";
        const agentDir = resolveOpenClawAgentDir();
        await writeCodexOauthProfile(agentDir);
        const existingParsed = {
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
        };
        const plan = await planOpenClawModelsJson({
          cfg: {},
          sourceConfigForSecrets: {},
          agentDir,
          env: createConfigRuntimeEnv({}),
          existingRaw: `${JSON.stringify(existingParsed, null, 2)}\n`,
          existingParsed,
        });

        expect(plan.action).toBe("write");
        const parsed = JSON.parse((plan as { contents: string }).contents) as {
          providers: Record<string, { baseUrl?: string; api?: string }>;
        };
        expect(parsed.providers["openai-codex"]).toMatchObject({
          baseUrl: "https://chatgpt.com/backend-api",
          api: "openai-codex-responses",
        });
      });
    });
  });

  it("preserves an existing baseUrl for explicit openai-codex config without oauth synthesis", async () => {
    await withModelsTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
        process.env.OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS = "openai-codex";
        const agentDir = resolveOpenClawAgentDir();
        const cfg = {
          models: {
            mode: "merge",
            providers: {
              "openai-codex": {
                baseUrl: "",
                api: "openai-codex-responses",
                models: [],
              },
            },
          },
        };
        const existingParsed = {
          providers: {
            "openai-codex": {
              baseUrl: "https://chatgpt.com/backend-api",
              api: "openai-codex-responses",
              models: [],
            },
          },
        };
        const plan = await planOpenClawModelsJson({
          cfg,
          sourceConfigForSecrets: cfg,
          agentDir,
          env: createConfigRuntimeEnv(cfg),
          existingRaw: `${JSON.stringify(existingParsed, null, 2)}\n`,
          existingParsed,
        });

        expect(plan.action).toBe("write");
        const parsed = JSON.parse((plan as { contents: string }).contents) as {
          providers: Record<string, { baseUrl?: string; api?: string }>;
        };
        expect(parsed.providers["openai-codex"]).toMatchObject({
          baseUrl: "https://chatgpt.com/backend-api",
          api: "openai-codex-responses",
        });
      });
    });
  });
});
