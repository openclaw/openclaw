import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
  withTempEnv,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  syncExternalCliCredentials: () => false,
}));

import { ensureOpenClawModelsJson, resetModelsJsonReadyCacheForTest } from "./models-config.js";

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
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    resetModelsJsonReadyCacheForTest();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    resetModelsJsonReadyCacheForTest();
  });

  it("writes marker-backed defaults but skips env-gated providers when no env token or profile exists", async () => {
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

        const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
        const parsed = JSON.parse(raw) as { providers: Record<string, ProviderConfig> };

        expect(result.wrote).toBe(true);
        expect(Object.keys(parsed.providers)).toEqual(
          expect.arrayContaining(["chutes", "deepseek", "mistral", "xai"]),
        );
        expect(parsed.providers["deepseek"]?.apiKey).toBe("DEEPSEEK_API_KEY");
        expect(parsed.providers["mistral"]?.apiKey).toBe("MISTRAL_API_KEY");
        expect(parsed.providers["xai"]?.apiKey).toBe("XAI_API_KEY");
        expect(parsed.providers["openai"]).toBeUndefined();
        expect(parsed.providers["minimax"]).toBeUndefined();
        expect(parsed.providers["synthetic"]).toBeUndefined();
      });
    });
  });

  it("writes models.json for configured providers", async () => {
    await withTempHome(async () => {
      await ensureOpenClawModelsJson(CUSTOM_PROXY_MODELS_CONFIG);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<
          string,
          {
            baseUrl?: string;
            models?: Array<{
              id?: string;
              cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
            }>;
          }
        >;
      };

      expect(parsed.providers["custom-proxy"]?.baseUrl).toBe("http://localhost:4000/v1");
      expect(parsed.providers["custom-proxy"]?.models?.[0]).toMatchObject({
        id: "llama-3.1-8b",
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    });
  });

  it("adds minimax provider when MINIMAX_API_KEY is set", async () => {
    await withTempHome(async () => {
      await runEnvProviderCase({
        envVar: "MINIMAX_API_KEY",
        envValue: "sk-minimax-test",
        providerKey: "minimax",
        expectedBaseUrl: "https://api.minimax.io/anthropic",
        expectedApiKeyRef: "MINIMAX_API_KEY", // pragma: allowlist secret
        expectedModelIds: ["MiniMax-M2.7", "MiniMax-VL-01"],
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
        expectedApiKeyRef: "SYNTHETIC_API_KEY", // pragma: allowlist secret
        expectedModelIds: ["hf:MiniMaxAI/MiniMax-M2.5"],
      });
    });
  });
});
