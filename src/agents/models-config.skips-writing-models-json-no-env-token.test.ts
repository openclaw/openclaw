import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
  withTempEnv,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import type { ProviderConfig as ModelsProviderConfig } from "./models-config.providers.secrets.js";

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  syncExternalCliCredentials: () => false,
}));

vi.mock("./models-config.providers.js", async () => {
  function createImplicitProvider(baseUrl: string): ModelsProviderConfig {
    return {
      baseUrl,
      api: "openai-completions",
      models: [
        {
          id: "test-model",
          name: "test-model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
      ],
    };
  }

  return {
    applyNativeStreamingUsageCompat: (providers: Record<string, ModelsProviderConfig>) => providers,
    enforceSourceManagedProviderSecrets: ({
      providers,
    }: {
      providers: Record<string, ModelsProviderConfig>;
    }) => providers,
    normalizeProviders: ({ providers }: { providers: Record<string, ModelsProviderConfig> }) =>
      providers,
    resolveImplicitProviders: async ({ env }: { env?: NodeJS.ProcessEnv }) => {
      const providers: Record<string, ModelsProviderConfig> = {
        chutes: {
          baseUrl: "https://llm.chutes.ai/v1",
          api: "openai-completions" as const,
          models: [],
        },
        deepseek: {
          ...createImplicitProvider("https://deepseek.example/v1"),
          apiKey: "DEEPSEEK_API_KEY",
        },
        mistral: {
          ...createImplicitProvider("https://mistral.example/v1"),
          apiKey: "MISTRAL_API_KEY",
        },
        xai: {
          ...createImplicitProvider("https://xai.example/v1"),
          apiKey: "XAI_API_KEY",
        },
      };
      if (env?.MINIMAX_API_KEY) {
        providers["minimax"] = {
          ...createImplicitProvider("https://minimax.example/v1"),
          apiKey: "MINIMAX_API_KEY",
        };
      }
      if (env?.SYNTHETIC_API_KEY) {
        providers["synthetic"] = {
          ...createImplicitProvider("https://synthetic.example/v1"),
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
  expectedApiKeyRef: string;
}) {
  const previousValue = process.env[params.envVar];
  process.env[params.envVar] = params.envValue;
  try {
    await ensureOpenClawModelsJson({});

    const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
    const raw = await fs.readFile(modelPath, "utf8");
    const parsed = JSON.parse(raw) as { providers: Record<string, ParsedProviderConfig> };
    const provider = parsed.providers[params.providerKey];
    expect(provider).toBeDefined();
    expect(provider?.apiKey).toBe(params.expectedApiKeyRef);
  } finally {
    if (previousValue === undefined) {
      delete process.env[params.envVar];
    } else {
      process.env[params.envVar] = previousValue;
    }
  }
}

describe("models-config", () => {
  beforeAll(async () => {
    ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
    ({ clearRuntimeAuthProfileStoreSnapshots } = await import("./auth-profiles/store.js"));
    ({ ensureOpenClawModelsJson, resetModelsJsonReadyCacheForTest } =
      await import("./models-config.js"));
  });

  beforeEach(() => {
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
        expect(Object.keys(parsed.providers).length).toBeGreaterThan(0);
        expect(parsed.providers["openai"]).toBeUndefined();
        expect(parsed.providers["minimax"]).toBeUndefined();
        expect(parsed.providers["synthetic"]).toBeUndefined();
      });
    });
  });

  it("inherits models.json from main agent for new secondary agents when plan skips", async () => {
    await withTempHome(async (home) => {
      await withTempEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS], async () => {
        unsetEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS]);

        const mainModels = {
          providers: {
            botzhipin: {
              baseUrl: "https://botzhipin.work/openclaw/platform/v1",
              apiKey: "BOTZHIPIN_API_KEY",
              api: "openai-completions",
              models: [
                {
                  id: "deep",
                  name: "Deep",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 131072,
                  maxTokens: 8192,
                },
              ],
            },
          },
        };

        const mainAgentDir = resolveOpenClawAgentDir();
        await fs.mkdir(mainAgentDir, { recursive: true });
        await fs.writeFile(
          path.join(mainAgentDir, "models.json"),
          `${JSON.stringify(mainModels, null, 2)}\n`,
          "utf8",
        );

        const secondaryAgentDir = path.join(home, ".openclaw", "agents", "email-expert", "agent");

        vi.resetModules();
        const planOpenClawModelsJson = vi.fn(async () => ({ action: "skip" as const }));
        vi.doMock("./models-config.plan.js", () => ({
          planOpenClawModelsJson,
        }));

        try {
          const { ensureOpenClawModelsJson, resetModelsJsonReadyCacheForTest } =
            await import("./models-config.js");
          resetModelsJsonReadyCacheForTest();

          const result = await ensureOpenClawModelsJson(
            { models: { providers: {} } },
            secondaryAgentDir,
          );
          expect(result.wrote).toBe(true);
          expect(planOpenClawModelsJson).toHaveBeenCalled();

          const copied = JSON.parse(
            await fs.readFile(path.join(secondaryAgentDir, "models.json"), "utf8"),
          ) as unknown;
          expect(copied).toEqual(mainModels);
        } finally {
          vi.doUnmock("./models-config.plan.js");
          vi.resetModules();
        }
      });
    });
  });

  it("retries non-main bootstrap when main models.json appears after an initial skip", async () => {
    await withTempHome(async (home) => {
      await withTempEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS], async () => {
        unsetEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS]);

        const mainModels = {
          providers: {
            botzhipin: {
              baseUrl: "https://botzhipin.work/openclaw/platform/v1",
              apiKey: "BOTZHIPIN_API_KEY",
              api: "openai-completions",
              models: [
                {
                  id: "deep",
                  name: "Deep",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 131072,
                  maxTokens: 8192,
                },
              ],
            },
          },
        };

        const mainAgentDir = resolveOpenClawAgentDir();
        const secondaryAgentDir = path.join(home, ".openclaw", "agents", "email-expert", "agent");

        vi.resetModules();
        const planOpenClawModelsJson = vi.fn(async () => ({ action: "skip" as const }));
        vi.doMock("./models-config.plan.js", () => ({
          planOpenClawModelsJson,
        }));

        try {
          const { ensureOpenClawModelsJson, resetModelsJsonReadyCacheForTest } =
            await import("./models-config.js");
          resetModelsJsonReadyCacheForTest();

          const first = await ensureOpenClawModelsJson(
            { models: { providers: {} } },
            secondaryAgentDir,
          );
          expect(first.wrote).toBe(false);
          expect(planOpenClawModelsJson).toHaveBeenCalledTimes(1);

          await fs.mkdir(mainAgentDir, { recursive: true });
          await fs.writeFile(
            path.join(mainAgentDir, "models.json"),
            `${JSON.stringify(mainModels, null, 2)}\n`,
            "utf8",
          );

          const second = await ensureOpenClawModelsJson(
            { models: { providers: {} } },
            secondaryAgentDir,
          );
          expect(second.wrote).toBe(true);
          expect(planOpenClawModelsJson).toHaveBeenCalledTimes(2);

          const copied = JSON.parse(
            await fs.readFile(path.join(secondaryAgentDir, "models.json"), "utf8"),
          ) as unknown;
          expect(copied).toEqual(mainModels);
        } finally {
          vi.doUnmock("./models-config.plan.js");
          vi.resetModules();
        }
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
        expectedApiKeyRef: "MINIMAX_API_KEY", // pragma: allowlist secret
      });
    });
  });

  it("adds synthetic provider when SYNTHETIC_API_KEY is set", async () => {
    await withTempHome(async () => {
      await runEnvProviderCase({
        envVar: "SYNTHETIC_API_KEY",
        envValue: "sk-synthetic-test",
        providerKey: "synthetic",
        expectedApiKeyRef: "SYNTHETIC_API_KEY", // pragma: allowlist secret
      });
    });
  });
});
