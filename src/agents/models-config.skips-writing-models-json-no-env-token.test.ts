import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
  withTempEnv,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import type { ProviderConfig as ModelsProviderConfig } from "./models-config.providers.js";

function createModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function buildDeepSeekProvider(): ModelsProviderConfig {
  return {
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    models: [createModel("deepseek-chat")],
  };
}

function buildMinimaxProvider(): ModelsProviderConfig {
  return {
    baseUrl: "https://api.minimax.io/anthropic",
    api: "anthropic-messages",
    models: [createModel("MiniMax-M2.7")],
  };
}

function buildMistralProvider(): ModelsProviderConfig {
  return {
    baseUrl: "https://api.mistral.ai/v1",
    api: "openai-completions",
    models: [createModel("mistral-medium-latest")],
  };
}

function buildSyntheticProvider(): ModelsProviderConfig {
  return {
    baseUrl: "https://api.synthetic.new/anthropic",
    api: "anthropic-messages",
    models: [createModel("hf:MiniMaxAI/MiniMax-M2.5")],
  };
}

function buildXaiProvider(): ModelsProviderConfig {
  return {
    baseUrl: "https://api.x.ai/v1",
    api: "openai-completions",
    models: [createModel("grok-4-fast")],
  };
}

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  syncExternalCliCredentials: () => false,
}));

vi.mock("./models-config.providers.js", async () => {
  const actual = await vi.importActual<typeof import("./models-config.providers.js")>(
    "./models-config.providers.js",
  );
  return {
    ...actual,
    resolveImplicitProviders: async ({ env }: { env?: NodeJS.ProcessEnv }) => {
      const providers: Record<string, ModelsProviderConfig> = {
        chutes: {
          baseUrl: "https://llm.chutes.ai/v1",
          api: "openai-completions" as const,
          models: [],
        },
        deepseek: {
          ...buildDeepSeekProvider(),
          apiKey: "DEEPSEEK_API_KEY",
        },
        mistral: {
          ...buildMistralProvider(),
          apiKey: "MISTRAL_API_KEY",
        },
        xai: {
          ...buildXaiProvider(),
          apiKey: "XAI_API_KEY",
        },
      };
      if (env?.MINIMAX_API_KEY) {
        providers["minimax"] = {
          ...buildMinimaxProvider(),
          apiKey: "MINIMAX_API_KEY",
        };
      }
      if (env?.SYNTHETIC_API_KEY) {
        providers["synthetic"] = {
          ...buildSyntheticProvider(),
          apiKey: "SYNTHETIC_API_KEY",
        };
      }
      return providers;
    },
  };
});

installModelsConfigTestHooks();

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let clearRuntimeAuthProfileStoreSnapshots: typeof import("./auth-profiles/store.js").clearRuntimeAuthProfileStoreSnapshots;
let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;
let resetModelsJsonReadyCacheForTest: typeof import("./models-config.js").resetModelsJsonReadyCacheForTest;

type ParsedProviderConfig = {
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
    const parsed = JSON.parse(raw) as { providers: Record<string, ParsedProviderConfig> };
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
  beforeEach(async () => {
    vi.resetModules();
    ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
    ({ clearRuntimeAuthProfileStoreSnapshots } = await import("./auth-profiles/store.js"));
    ({ ensureOpenClawModelsJson, resetModelsJsonReadyCacheForTest } =
      await import("./models-config.js"));
    clearRuntimeAuthProfileStoreSnapshots();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    resetModelsJsonReadyCacheForTest();
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
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
        const parsed = JSON.parse(raw) as { providers: Record<string, ParsedProviderConfig> };

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
        expectedModelIds: ["MiniMax-M2.7"],
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
