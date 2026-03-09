import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  installModelsConfigTestHooks,
  unsetEnv,
  withModelsTempHome as withTempHome,
  withTempEnv,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { readGeneratedModelsJson } from "./models-config.test-utils.js";

installModelsConfigTestHooks();

describe("models-config skips implicit providers when explicit configured", () => {
  it("when explicit providers configured + implicit env vars present → only explicit providers appear", async () => {
    await withTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
        process.env.MOONSHOT_API_KEY = "sk-moonshot-test";

        await ensureOpenClawModelsJson(CUSTOM_PROXY_MODELS_CONFIG);

        const parsed = await readGeneratedModelsJson<{
          providers: Record<string, { baseUrl?: string; apiKey?: string }>;
        }>();

        expect(parsed.providers["custom-proxy"]).toBeDefined();
        expect(parsed.providers["custom-proxy"]?.baseUrl).toBe("http://localhost:4000/v1");
        expect(parsed.providers.moonshot).toBeUndefined();
      });
    });
  });

  it("when explicit providers configured + AWS_PROFILE set → no bedrock discovery", async () => {
    await withTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
        process.env.AWS_PROFILE = "my-profile";

        await ensureOpenClawModelsJson(CUSTOM_PROXY_MODELS_CONFIG);

        const parsed = await readGeneratedModelsJson<{
          providers: Record<string, unknown>;
        }>();

        expect(parsed.providers["custom-proxy"]).toBeDefined();
        expect(parsed.providers["amazon-bedrock"]).toBeUndefined();
      });
    });
  });

  it("when explicit providers include amazon-bedrock → bedrock config is preserved", async () => {
    await withTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

        const cfgWithBedrock: OpenClawConfig = {
          models: {
            providers: {
              "custom-proxy": {
                baseUrl: "http://localhost:4000/v1",
                apiKey: "TEST_KEY",
                api: "openai-completions",
                models: [
                  {
                    id: "llama-3.1-8b",
                    name: "Llama 3.1 8B (Proxy)",
                    api: "openai-completions",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 32000,
                  },
                ],
              },
              "amazon-bedrock": {
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                api: "bedrock-converse-stream",
                auth: "aws-sdk",
                models: [
                  {
                    id: "us.anthropic.claude-sonnet-4-20250514-v1:0",
                    name: "Claude Sonnet (Bedrock)",
                    api: "bedrock-converse-stream",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                    contextWindow: 200000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
        };

        await ensureOpenClawModelsJson(cfgWithBedrock);

        const parsed = await readGeneratedModelsJson<{
          providers: Record<string, { baseUrl?: string }>;
        }>();

        expect(parsed.providers["custom-proxy"]).toBeDefined();
        expect(parsed.providers["amazon-bedrock"]).toBeDefined();
        expect(parsed.providers["amazon-bedrock"]?.baseUrl).toBe(
          "https://bedrock-runtime.us-east-1.amazonaws.com",
        );
      });
    });
  });

  it("when no explicit providers configured → implicit detection still works", async () => {
    await withTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
        process.env.MOONSHOT_API_KEY = "sk-moonshot-test";

        const cfg: OpenClawConfig = {};
        await ensureOpenClawModelsJson(cfg);

        const parsed = await readGeneratedModelsJson<{
          providers: Record<string, { apiKey?: string }>;
        }>();

        expect(parsed.providers.moonshot).toBeDefined();
        expect(parsed.providers.moonshot?.apiKey).toBe("MOONSHOT_API_KEY");
      });
    });
  });
});
