import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
  withTempEnv,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

installModelsConfigTestHooks();

type ProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  models?: Array<{ id: string }>;
};

type ModelsJson = {
  providers: Record<string, ProviderConfig>;
};

describe("models-config – skip implicit providers when explicit providers are configured", () => {
  it("does not include implicit env-var providers when explicit providers are set", async () => {
    await withTempHome(async () => {
      // Set env vars that would normally trigger implicit provider discovery.
      await withTempEnv(["MINIMAX_API_KEY", ...MODELS_CONFIG_IMPLICIT_ENV_VARS], async () => {
        process.env.MINIMAX_API_KEY = "sk-minimax-test";

        // Configure an explicit provider – implicit detection should be skipped.
        await ensureOpenClawModelsJson(CUSTOM_PROXY_MODELS_CONFIG);

        const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
        const raw = await fs.readFile(modelPath, "utf8");
        const parsed = JSON.parse(raw) as ModelsJson;

        // Explicit provider must be present.
        expect(parsed.providers["custom-proxy"]).toBeDefined();
        expect(parsed.providers["custom-proxy"]?.baseUrl).toBe("http://localhost:4000/v1");

        // Implicit minimax provider must NOT be present.
        expect(parsed.providers["minimax"]).toBeUndefined();
      });
    });
  });

  it("still uses implicit providers when no explicit providers are configured", async () => {
    await withTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
        process.env.MINIMAX_API_KEY = "sk-minimax-test";

        // Empty explicit providers – implicit detection should kick in.
        await ensureOpenClawModelsJson({});

        const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
        const raw = await fs.readFile(modelPath, "utf8");
        const parsed = JSON.parse(raw) as ModelsJson;

        // Minimax should be discovered implicitly.
        expect(parsed.providers["minimax"]).toBeDefined();
        expect(parsed.providers["minimax"]?.apiKey).toBe("MINIMAX_API_KEY");
      });
    });
  });

  it("skips models.json when explicit providers are empty and no env tokens exist", async () => {
    await withTempHome(async (home) => {
      await withTempEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS, "KIMI_API_KEY"], async () => {
        unsetEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS, "KIMI_API_KEY"]);

        const agentDir = path.join(home, "agent-no-providers");
        process.env.OPENCLAW_AGENT_DIR = agentDir;
        process.env.PI_CODING_AGENT_DIR = agentDir;

        const result = await ensureOpenClawModelsJson({ models: { providers: {} } }, agentDir);

        expect(result.wrote).toBe(false);
      });
    });
  });
});
