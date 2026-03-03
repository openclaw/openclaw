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
