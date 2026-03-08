import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  installModelsConfigTestHooks,
  unsetEnv,
  withModelsTempHome as withTempHome,
  withTempEnv,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

installModelsConfigTestHooks();

const TEST_ENV_VAR = "OPENCLAW_MODELS_CONFIG_TEST_ENV";

describe("models-config", () => {
  it("uses config env.vars entries for implicit provider discovery without mutating process.env", async () => {
    await withTempHome(async () => {
      await withTempEnv(["OPENROUTER_API_KEY", TEST_ENV_VAR], async () => {
        unsetEnv(["OPENROUTER_API_KEY", TEST_ENV_VAR]);
        const cfg: OpenClawConfig = {
          models: { providers: {} },
          env: {
            vars: {
              OPENROUTER_API_KEY: "from-config",
              [TEST_ENV_VAR]: "from-config",
            },
          },
        };

        const { agentDir } = await ensureOpenClawModelsJson(cfg);

        expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
        expect(process.env[TEST_ENV_VAR]).toBeUndefined();

        const modelsJson = JSON.parse(await fs.readFile(`${agentDir}/models.json`, "utf8")) as {
          providers?: { openrouter?: { apiKey?: string } };
        };
        expect(modelsJson.providers?.openrouter?.apiKey).toBe("OPENROUTER_API_KEY");
      });
    });
  });

  it("does not overwrite already-set host env vars while ensuring models.json", async () => {
    await withTempHome(async () => {
      await withTempEnv(["OPENROUTER_API_KEY", TEST_ENV_VAR], async () => {
        process.env.OPENROUTER_API_KEY = "from-host";
        process.env[TEST_ENV_VAR] = "from-host";
        const cfg: OpenClawConfig = {
          models: { providers: {} },
          env: {
            vars: {
              OPENROUTER_API_KEY: "from-config",
              [TEST_ENV_VAR]: "from-config",
            },
          },
        };

        const { agentDir } = await ensureOpenClawModelsJson(cfg);

        const modelsJson = JSON.parse(await fs.readFile(`${agentDir}/models.json`, "utf8")) as {
          providers?: { openrouter?: { apiKey?: string } };
        };
        expect(modelsJson.providers?.openrouter?.apiKey).toBe("OPENROUTER_API_KEY");
        expect(process.env.OPENROUTER_API_KEY).toBe("from-host");
        expect(process.env[TEST_ENV_VAR]).toBe("from-host");
      });
    });
  });
});
