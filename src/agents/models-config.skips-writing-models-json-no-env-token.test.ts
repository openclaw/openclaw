// Verifies models.json generation skips env-gated providers until auth exists.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resolveDefaultAgentDir } from "./agent-scope.js";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
  withTempEnv,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import type { ProviderConfig as ModelsProviderConfig } from "./models-config.providers.secrets.js";
import { PLUGIN_MODEL_CATALOG_GENERATED_BY } from "./plugin-model-catalog.js";

const PLUGIN_MODEL_CATALOG_FILE = "catalog.json";

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  resolveExternalCliAuthProfiles: () => [],
  syncExternalCliCredentials: () => false,
}));

vi.mock("./models-config.providers.js", async () => {
  function createImplicitProvider(baseUrl: string): ModelsProviderConfig {
    // Shared implicit-provider fixture keeps generated-provider expectations compact.
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
    normalizeProviderCatalogModelsForConfig: (providers: Record<string, ModelsProviderConfig>) =>
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
let resetModelsJsonReadyCacheForTest: typeof import("./models-config-state.test-support.js").resetModelsJsonReadyCacheForTest;

type ParsedProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  auth?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  request?: unknown;
  models?: Array<{ id: string; headers?: Record<string, string>; request?: unknown }>;
};

async function readGeneratedProviders(
  agentDir: string,
): Promise<Record<string, ParsedProviderConfig>> {
  // Generated plugin catalogs are separate files but part of the effective provider set.
  const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
  const parsed = JSON.parse(raw) as { providers?: Record<string, ParsedProviderConfig> };
  const providers = { ...parsed.providers };
  const pluginsDir = path.join(agentDir, "plugins");
  let pluginDirs: Array<import("node:fs").Dirent>;
  try {
    pluginDirs = await fs.readdir(pluginsDir, { withFileTypes: true });
  } catch {
    return providers;
  }
  for (const entry of pluginDirs) {
    if (!entry.isDirectory()) {
      continue;
    }
    const catalogPath = path.join(pluginsDir, entry.name, PLUGIN_MODEL_CATALOG_FILE);
    const catalogRaw = await fs.readFile(catalogPath, "utf8").catch(() => undefined);
    if (!catalogRaw) {
      continue;
    }
    const catalog = JSON.parse(catalogRaw) as {
      generatedBy?: string;
      providers?: Record<string, ParsedProviderConfig>;
    };
    if (catalog.generatedBy === PLUGIN_MODEL_CATALOG_GENERATED_BY) {
      Object.assign(providers, catalog.providers);
    }
  }
  return providers;
}

async function runEnvProviderCase(params: {
  envVar: "MINIMAX_API_KEY" | "SYNTHETIC_API_KEY";
  envValue: string;
  providerKey: "minimax" | "synthetic";
  expectedApiKeyRef: string;
}) {
  // Mutate one env var at a time so auth-gated provider generation stays isolated.
  const envSnapshot = captureEnv([params.envVar]);
  setTestEnvValue(params.envVar, params.envValue);
  try {
    await ensureOpenClawModelsJson({});

    const provider = (await readGeneratedProviders(resolveDefaultAgentDir({})))[params.providerKey];
    expect(provider?.apiKey).toBe(params.expectedApiKeyRef);
  } finally {
    envSnapshot.restore();
  }
}

describe("models-config", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
    ({ clearRuntimeAuthProfileStoreSnapshots } = await import("./auth-profiles/store.js"));
    ({ ensureOpenClawModelsJson } = await import("./models-config.js"));
    ({ resetModelsJsonReadyCacheForTest } = await import("./models-config-state.test-support.js"));
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
        setTestEnvValue("OPENCLAW_AGENT_DIR", agentDir);

        const result = await ensureOpenClawModelsJson(
          {
            models: { providers: {} },
          },
          agentDir,
        );

        const providers = await readGeneratedProviders(agentDir);

        expect(result.wrote).toBe(true);
        expect(Object.keys(providers).toSorted()).toStrictEqual([
          "chutes",
          "deepseek",
          "mistral",
          "xai",
        ]);
        expect(providers["openai"]).toBeUndefined();
        expect(providers["minimax"]).toBeUndefined();
        expect(providers["synthetic"]).toBeUndefined();
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
              apiKey: "main-agent-api-key",
              auth: "api-key",
              authHeader: false,
              api: "openai-completions",
              headers: {
                Authorization: "Bearer main-agent-token",
              },
              request: {
                proxy: "http://proxy.example:8080",
                tls: {
                  cert: "main-agent-cert",
                  key: "main-agent-key",
                },
              },
              models: [
                {
                  id: "deep",
                  name: "Deep",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 131072,
                  maxTokens: 8192,
                  headers: {
                    "x-model-token": "main-model-token",
                  },
                },
              ],
            },
          },
        };
        const expectedInheritedModels = {
          providers: {
            botzhipin: {
              baseUrl: "https://botzhipin.work/openclaw/platform/v1",
              auth: "api-key",
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

        const mainAgentDir = resolveDefaultAgentDir({});
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
          const {
            ensureOpenClawModelsJson: ensureOpenClawModelsJsonForSkip,
            resetModelsJsonReadyCacheForTest: resetModelsJsonReadyCacheForSkip,
          } = await import("./models-config.js");
          resetModelsJsonReadyCacheForSkip();

          const result = await ensureOpenClawModelsJsonForSkip(
            { models: { providers: {} } },
            secondaryAgentDir,
          );
          expect(result.wrote).toBe(true);
          expect(planOpenClawModelsJson).toHaveBeenCalled();

          const copiedRaw = await fs.readFile(path.join(secondaryAgentDir, "models.json"), "utf8");
          const copied = JSON.parse(copiedRaw) as unknown;
          expect(copied).toEqual(expectedInheritedModels);
          expect(copiedRaw).not.toContain("main-agent-api-key");
          expect(copiedRaw).not.toContain("main-agent-token");
          expect(copiedRaw).not.toContain("proxy.example");
          expect(copiedRaw).not.toContain("main-agent-cert");
          expect(copiedRaw).not.toContain("main-agent-key");
          expect(copiedRaw).not.toContain("main-model-token");
        } finally {
          vi.doUnmock("./models-config.plan.js");
          vi.resetModules();
        }
      });
    });
  });

  it("does not overwrite models.json created concurrently during non-main bootstrap", async () => {
    await withTempHome(async (home) => {
      await withTempEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS], async () => {
        unsetEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS]);

        const mainModels = {
          providers: {
            botzhipin: {
              baseUrl: "https://botzhipin.work/openclaw/platform/v1",
              apiKey: "main-agent-api-key",
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
        const concurrentModels = {
          providers: {
            workerOnly: {
              baseUrl: "https://worker-only.example/v1",
              apiKey: "worker-only-api-key",
              api: "openai-completions",
              models: [],
            },
          },
        };

        const mainAgentDir = resolveDefaultAgentDir({});
        await fs.mkdir(mainAgentDir, { recursive: true });
        await fs.writeFile(
          path.join(mainAgentDir, "models.json"),
          `${JSON.stringify(mainModels, null, 2)}\n`,
          "utf8",
        );

        const secondaryAgentDir = path.join(home, ".openclaw", "agents", "email-expert", "agent");
        const secondaryModelsPath = path.join(secondaryAgentDir, "models.json");

        vi.resetModules();
        const planOpenClawModelsJson = vi.fn(async () => ({ action: "skip" as const }));
        vi.doMock("./models-config.plan.js", () => ({
          planOpenClawModelsJson,
        }));

        const linkSpy = vi.spyOn(fs, "link").mockImplementationOnce(async (_source, target) => {
          const targetPath = typeof target === "string" ? target : target.toString();
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, `${JSON.stringify(concurrentModels, null, 2)}\n`, "utf8");
          const error = new Error("target already exists") as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error;
        });

        try {
          const {
            ensureOpenClawModelsJson: ensureOpenClawModelsJsonForSkip,
            resetModelsJsonReadyCacheForTest: resetModelsJsonReadyCacheForSkip,
          } = await import("./models-config.js");
          resetModelsJsonReadyCacheForSkip();

          const result = await ensureOpenClawModelsJsonForSkip(
            { models: { providers: {} } },
            secondaryAgentDir,
          );
          expect(result.wrote).toBe(false);
          expect(planOpenClawModelsJson).toHaveBeenCalled();

          const existing = JSON.parse(await fs.readFile(secondaryModelsPath, "utf8")) as unknown;
          expect(existing).toEqual(concurrentModels);
        } finally {
          linkSpy.mockRestore();
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
              apiKey: "main-agent-api-key",
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
        const expectedInheritedModels = {
          providers: {
            botzhipin: {
              baseUrl: "https://botzhipin.work/openclaw/platform/v1",
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

        const mainAgentDir = resolveDefaultAgentDir({});
        const secondaryAgentDir = path.join(home, ".openclaw", "agents", "email-expert", "agent");

        vi.resetModules();
        const planOpenClawModelsJson = vi.fn(async () => ({ action: "skip" as const }));
        vi.doMock("./models-config.plan.js", () => ({
          planOpenClawModelsJson,
        }));

        try {
          const {
            ensureOpenClawModelsJson: ensureOpenClawModelsJsonForSkip,
            resetModelsJsonReadyCacheForTest: resetModelsJsonReadyCacheForSkip,
          } = await import("./models-config.js");
          resetModelsJsonReadyCacheForSkip();

          const first = await ensureOpenClawModelsJsonForSkip(
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

          const second = await ensureOpenClawModelsJsonForSkip(
            { models: { providers: {} } },
            secondaryAgentDir,
          );
          expect(second.wrote).toBe(true);
          expect(planOpenClawModelsJson).toHaveBeenCalledTimes(2);

          const copied = JSON.parse(
            await fs.readFile(path.join(secondaryAgentDir, "models.json"), "utf8"),
          ) as unknown;
          expect(copied).toEqual(expectedInheritedModels);
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

      const modelPath = path.join(resolveDefaultAgentDir({}), "models.json");
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
      const model = parsed.providers["custom-proxy"]?.models?.[0];
      expect(model?.id).toBe("llama-3.1-8b");
      expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });
  });

  it("preserves existing generated plugin catalog secrets in merge mode", async () => {
    await withTempHome(async (home) => {
      const agentDir = path.join(home, "agent-plugin-merge");
      const catalogPath = path.join(agentDir, "plugins", "deepseek", PLUGIN_MODEL_CATALOG_FILE);
      await fs.mkdir(path.dirname(catalogPath), { recursive: true });
      await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
      await fs.writeFile(
        catalogPath,
        JSON.stringify(
          {
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: {
              deepseek: {
                baseUrl: "https://persisted.example/v1",
                api: "openai-completions",
                apiKey: "persisted-key",
                models: [{ id: "test-model" }],
              },
            },
          },
          null,
          2,
        ),
      );
      const pluginMetadataSnapshot = {
        index: { plugins: [{ pluginId: "deepseek", enabled: true }] },
        normalizePluginId: (pluginId: string) => pluginId,
        manifestRegistry: { plugins: [], diagnostics: [] },
        owners: {
          providers: new Map([["deepseek", ["deepseek"]]]),
          modelCatalogProviders: new Map([["deepseek", ["deepseek"]]]),
          setupProviders: new Map(),
        },
      } as unknown as Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;

      await ensureOpenClawModelsJson({ models: { providers: {} } }, agentDir, {
        pluginMetadataSnapshot,
      });

      const raw = await fs.readFile(catalogPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, ParsedProviderConfig>;
      };
      expect(parsed.providers.deepseek?.baseUrl).toBe("https://persisted.example/v1");
      expect(parsed.providers.deepseek).toBeDefined();
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
