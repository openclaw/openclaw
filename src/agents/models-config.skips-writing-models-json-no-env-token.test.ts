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

async function runEnvProviderCase(params: {
  envVar: "MINIMAX_API_KEY" | "SYNTHETIC_API_KEY";
  envValue: string;
  providerKey: "minimax" | "synthetic";
  expectedBaseUrl: string;
  expectedApiKeyRef: string;
  expectedModelIds: string[];
}) {
  const previousValue = process.env[params.envVar];
  process.env[params.envVar] = params.envValue;
  try {
    await ensureOpenClawModelsJson({});

    const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
    const raw = await fs.readFile(modelPath, "utf8");
    const parsed = JSON.parse(raw) as { providers: Record<string, ProviderConfig> };
    const provider = parsed.providers[params.providerKey];
    expect(provider?.baseUrl).toBe(params.expectedBaseUrl);
    expect(provider?.apiKey).toBe(params.expectedApiKeyRef);
    const ids = provider?.models?.map((model) => model.id) ?? [];
    for (const expectedId of params.expectedModelIds) {
      expect(ids).toContain(expectedId);
    }
  } finally {
    if (previousValue === undefined) {
      delete process.env[params.envVar];
    } else {
      process.env[params.envVar] = previousValue;
    }
  }
}

describe("models-config", () => {
  it("skips writing models.json when no env token or profile exists", async () => {
    await withTempHome(async (home) => {
      await withTempEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS, "KIMI_API_KEY"], async () => {
        unsetEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS, "KIMI_API_KEY"]);

        const agentDir = path.join(home, "agent-empty");
        // ensureAuthProfileStore merges the main auth store into non-main dirs; point main at our temp dir.
        process.env.OPENCLAW_AGENT_DIR = agentDir;
        process.env.PI_CODING_AGENT_DIR = agentDir;

        const result = await ensureOpenClawModelsJson(
          {
            models: { providers: {} },
          },
          agentDir,
        );

        await expect(fs.stat(path.join(agentDir, "models.json"))).rejects.toThrow();
        expect(result.wrote).toBe(false);
      });
    });
  });

  it("writes models.json for configured providers", async () => {
    await withTempHome(async () => {
      await ensureOpenClawModelsJson(CUSTOM_PROXY_MODELS_CONFIG);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { baseUrl?: string }>;
      };

      expect(parsed.providers["custom-proxy"]?.baseUrl).toBe("http://localhost:4000/v1");
    });
  });

  it("adds minimax provider when MINIMAX_API_KEY is set", async () => {
    await withTempHome(async () => {
      await runEnvProviderCase({
        envVar: "MINIMAX_API_KEY",
        envValue: "sk-minimax-test",
        providerKey: "minimax",
        expectedBaseUrl: "https://api.minimax.io/anthropic",
        expectedApiKeyRef: "MINIMAX_API_KEY",
        expectedModelIds: ["MiniMax-M2.1", "MiniMax-VL-01"],
      });
    });
  });

  it("adds synthetic provider when SYNTHETIC_API_KEY is set", async () => {
    await withTempHome(async () => {
      await runEnvProviderCase({
        envVar: "SYNTHETIC_API_KEY",
        envValue: "sk-synthetic-test",
        providerKey: "synthetic",
        expectedBaseUrl: "https://api.synthetic.new/anthropic",
        expectedApiKeyRef: "SYNTHETIC_API_KEY",
        expectedModelIds: ["hf:MiniMaxAI/MiniMax-M2.1"],
      });
    });
  });
});
