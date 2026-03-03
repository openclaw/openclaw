import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  installModelsConfigTestHooks,
  unsetEnv,
  withModelsTempHome as withTempHome,
  withTempEnv,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

installModelsConfigTestHooks();

const TEST_ENV_VAR = "OPENCLAW_MODELS_CONFIG_TEST_ENV";

describe("models-config", () => {
  it("applies config env.vars entries while ensuring models.json", async () => {
    await withTempHome(async () => {
      await withTempEnv([TEST_ENV_VAR], async () => {
        unsetEnv([TEST_ENV_VAR]);
        const cfg: OpenClawConfig = {
          ...CUSTOM_PROXY_MODELS_CONFIG,
          env: { vars: { [TEST_ENV_VAR]: "from-config" } },
        };

        await ensureOpenClawModelsJson(cfg);

        expect(process.env[TEST_ENV_VAR]).toBe("from-config");
      });
    });
  });

  it("does not overwrite already-set host env vars", async () => {
    await withTempHome(async () => {
      await withTempEnv([TEST_ENV_VAR], async () => {
        process.env[TEST_ENV_VAR] = "from-host";
        const cfg: OpenClawConfig = {
          ...CUSTOM_PROXY_MODELS_CONFIG,
          env: { vars: { [TEST_ENV_VAR]: "from-config" } },
        };

        await ensureOpenClawModelsJson(cfg);

        expect(process.env[TEST_ENV_VAR]).toBe("from-host");
      });
    });
  });
});
