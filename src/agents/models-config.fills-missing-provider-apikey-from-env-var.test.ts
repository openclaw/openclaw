import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { validateConfigObject } from "../config/validation.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  installModelsConfigTestHooks,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { readGeneratedModelsJson } from "./models-config.test-utils.js";

installModelsConfigTestHooks();

const MODELS_JSON_NAME = "models.json";

async function withEnvVar(name: string, value: string, run: () => Promise<void>) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

async function writeAgentModelsJson(content: unknown): Promise<void> {
  const agentDir = resolveOpenClawAgentDir();
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, MODELS_JSON_NAME),
    JSON.stringify(content, null, 2),
    "utf8",
  );
}

function createMergeConfigProvider() {
  return {
    baseUrl: "https://config.example/v1",
    apiKey: "CONFIG_KEY", // pragma: allowlist secret
    api: "openai-responses" as const,
    models: [
      {
        id: "config-model",
        name: "Config model",
        input: ["text"] as Array<"text" | "image">,
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 2048,
      },
    ],
  };
}

type MergeSeedProvider = {
  baseUrl: string;
  apiKey: string;
  api: string;
  models: Array<{ id: string; name: string; input: string[]; api?: string }>;
};

type MergeConfigApiKeyRef = {
  source: "env";
  provider: "default";
  id: string;
};

function createAgentSeedProvider(overrides: Partial<MergeSeedProvider> = {}): MergeSeedProvider {
  return {
    baseUrl: "https://agent.example/v1",
    apiKey: "AGENT_KEY", // pragma: allowlist secret
    api: "openai-responses",
    models: [{ id: "agent-model", name: "Agent model", input: ["text"] }],
    ...overrides,
  };
}

async function runCustomProviderMergeTest(params: {
  seedProvider: MergeSeedProvider;
  existingProviderKey?: string;
  configProviderKey?: string;
}) {
  const existingProviderKey = params.existingProviderKey ?? "custom";
  const configProviderKey = params.configProviderKey ?? "custom";
  await writeAgentModelsJson({ providers: { [existingProviderKey]: params.seedProvider } });
  await ensureOpenClawModelsJson({
    models: {
      mode: "merge",
      providers: {
        [configProviderKey]: createMergeConfigProvider(),
      },
    },
  });
  return readGeneratedModelsJson<{
    providers: Record<string, { apiKey?: string; baseUrl?: string }>;
  }>();
}

async function expectCustomProviderMergeResult(params: {
  seedProvider?: MergeSeedProvider;
  existingProviderKey?: string;
  configProviderKey?: string;
  expectedApiKey: string;
  expectedBaseUrl: string;
}) {
  await withTempHome(async () => {
    const parsed = await runCustomProviderMergeTest({
      seedProvider: params.seedProvider ?? createAgentSeedProvider(),
      existingProviderKey: params.existingProviderKey,
      configProviderKey: params.configProviderKey,
    });
    expect(parsed.providers.custom?.apiKey).toBe(params.expectedApiKey);
    expect(parsed.providers.custom?.baseUrl).toBe(params.expectedBaseUrl);
  });
}

async function expectCustomProviderApiKeyRewrite(params: {
  existingApiKey: string;
  configuredApiKey: string | MergeConfigApiKeyRef;
  expectedApiKey: string;
}) {
  await withTempHome(async () => {
    await writeAgentModelsJson({
      providers: {
        custom: createAgentSeedProvider({ apiKey: params.existingApiKey }),
      },
    });

    await ensureOpenClawModelsJson({
      models: {
        mode: "merge",
        providers: {
          custom: {
            ...createMergeConfigProvider(),
            apiKey: params.configuredApiKey,
          },
        },
      },
    });

    const parsed = await readGeneratedModelsJson<{
      providers: Record<string, { apiKey?: string; baseUrl?: string }>;
    }>();
    expect(parsed.providers.custom?.apiKey).toBe(params.expectedApiKey);
    expect(parsed.providers.custom?.baseUrl).toBe("https://config.example/v1");
  });
}

function createMoonshotConfig(overrides: {
  contextWindow: number;
  maxTokens: number;
}): OpenClawConfig {
  return {
    models: {
      providers: {
        moonshot: {
          baseUrl: "https://api.moonshot.ai/v1",
          api: "openai-completions",
          models: [
            {
              id: "kimi-k2.5",
              name: "Kimi K2.5",
              reasoning: false,
              input: ["text"],
              cost: { input: 123, output: 456, cacheRead: 0, cacheWrite: 0 },
              contextWindow: overrides.contextWindow,
              maxTokens: overrides.maxTokens,
            },
          ],
        },
      },
    },
  };
}

function createOpenAiConfigWithResolvedApiKey(mergeMode = false): OpenClawConfig {
  return {
    models: {
      ...(mergeMode ? { mode: "merge" as const } : {}),
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-plaintext-should-not-appear", // pragma: allowlist secret; simulates resolved ${OPENAI_API_KEY}
          api: "openai-completions",
          models: [
            {
              id: "gpt-4.1",
              name: "GPT-4.1",
              input: ["text"],
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
        },
      },
    },
  };
}

async function expectOpenAiEnvMarkerApiKey(options?: { seedMergedProvider?: boolean }) {
  await withEnvVar("OPENAI_API_KEY", "sk-plaintext-should-not-appear", async () => {
    await withTempHome(async () => {
      if (options?.seedMergedProvider) {
        await writeAgentModelsJson({
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: "STALE_AGENT_KEY", // pragma: allowlist secret
              api: "openai-completions",
              models: [{ id: "gpt-4.1", name: "GPT-4.1", input: ["text"] }],
            },
          },
        });
      }

      await ensureOpenClawModelsJson(
        createOpenAiConfigWithResolvedApiKey(options?.seedMergedProvider),
      );
      const result = await readGeneratedModelsJson<{
        providers: Record<string, { apiKey?: string }>;
      }>();
      expect(result.providers.openai?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
    });
  });
}

async function expectMoonshotTokenLimits(params: {
  contextWindow: number;
  maxTokens: number;
  expectedContextWindow: number;
  expectedMaxTokens: number;
}) {
  await withTempHome(async () => {
    await withEnvVar("MOONSHOT_API_KEY", "sk-moonshot-test", async () => {
      await ensureOpenClawModelsJson(
        createMoonshotConfig({
          contextWindow: params.contextWindow,
          maxTokens: params.maxTokens,
        }),
      );
      const parsed = await readGeneratedModelsJson<{
        providers: Record<
          string,
          {
            models?: Array<{
              id: string;
              contextWindow?: number;
              maxTokens?: number;
            }>;
          }
        >;
      }>();
      const kimi = parsed.providers.moonshot?.models?.find((model) => model.id === "kimi-k2.5");
      expect(kimi?.contextWindow).toBe(params.expectedContextWindow);
      expect(kimi?.maxTokens).toBe(params.expectedMaxTokens);
    });
  });
}

describe("models-config", () => {
  it("keeps anthropic api defaults when model entries omit api", async () => {
    await withTempHome(async () => {
      const validated = validateConfigObject({
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://relay.example.com/api",
              apiKey: "cr_xxxx", // pragma: allowlist secret
              models: [{ id: "claude-opus-4-6", name: "Claude Opus 4.6" }],
            },
          },
        },
      });
      expect(validated.ok).toBe(true);
      if (!validated.ok) {
        throw new Error("expected config to validate");
      }

      await ensureOpenClawModelsJson(validated.config);

      const parsed = await readGeneratedModelsJson<{
        providers: Record<string, { api?: string; models?: Array<{ id: string; api?: string }> }>;
      }>();

      expect(parsed.providers.anthropic?.api).toBe("anthropic-messages");
      expect(parsed.providers.anthropic?.models?.[0]?.api).toBe("anthropic-messages");
    });
  });

  it("fills missing provider.apiKey from env var name when models exist", async () => {
    await withTempHome(async () => {
      await withEnvVar("MINIMAX_API_KEY", "sk-minimax-test", async () => {
        const cfg: OpenClawConfig = {
          models: {
            providers: {
              minimax: {
                baseUrl: "https://api.minimax.io/anthropic",
                api: "anthropic-messages",
                models: [
                  {
                    id: "MiniMax-M2.7",
                    name: "MiniMax M2.7",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 200000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
        };

        await ensureOpenClawModelsJson(cfg);

        const parsed = await readGeneratedModelsJson<{
          providers: Record<string, { apiKey?: string; models?: Array<{ id: string }> }>;
        }>();
        expect(parsed.providers.minimax?.apiKey).toBe("MINIMAX_API_KEY"); // pragma: allowlist secret
      });
    });
  });

  it("fills anthropic-vertex apiKey with the ADC sentinel when models exist", async () => {
    await withTempHome(async () => {
      const adcDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-adc-"));
      const credentialsPath = path.join(adcDir, "application_default_credentials.json");
      await fs.writeFile(credentialsPath, JSON.stringify({ project_id: "vertex-project" }), "utf8");
      const previousCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;

      try {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

        await ensureOpenClawModelsJson({
          models: {
            providers: {
              "anthropic-vertex": {
                baseUrl: "https://us-central1-aiplatform.googleapis.com",
                api: "anthropic-messages",
                models: [
                  {
                    id: "claude-sonnet-4-6",
                    name: "Claude Sonnet 4.6",
                    reasoning: true,
                    input: ["text", "image"],
                    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                    contextWindow: 200000,
                    maxTokens: 64000,
                  },
                ],
              },
            },
          },
        });

        const parsed = await readGeneratedModelsJson<{
          providers: Record<string, { apiKey?: string }>;
        }>();
        expect(parsed.providers["anthropic-vertex"]?.apiKey).toBe("gcp-vertex-credentials");
      } finally {
        if (previousCredentials === undefined) {
          delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
        } else {
          process.env.GOOGLE_APPLICATION_CREDENTIALS = previousCredentials;
        }
        await fs.rm(adcDir, { recursive: true, force: true });
      }
    });
  });
  it("merges providers by default", async () => {
    await withTempHome(async () => {
      await writeAgentModelsJson({
        providers: {
          existing: {
            baseUrl: "http://localhost:1234/v1",
            apiKey: "EXISTING_KEY", // pragma: allowlist secret
            api: "openai-completions",
            models: [
              {
                id: "existing-model",
                name: "Existing",
                api: "openai-completions",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 2048,
              },
            ],
          },
        },
      });

      await ensureOpenClawModelsJson(CUSTOM_PROXY_MODELS_CONFIG);

      const parsed = await readGeneratedModelsJson<{
        providers: Record<string, { baseUrl?: string }>;
      }>();

      expect(parsed.providers.existing?.baseUrl).toBe("http://localhost:1234/v1");
      expect(parsed.providers["custom-proxy"]?.baseUrl).toBe("http://localhost:4000/v1");
    });
  });

  it("preserves non-empty agent apiKey but lets explicit config baseUrl win in merge mode", async () => {
    await expectCustomProviderMergeResult({
      expectedApiKey: "AGENT_KEY",
      expectedBaseUrl: "https://config.example/v1",
    });
  });

  it("lets explicit config baseUrl win in merge mode when the config provider key is normalized", async () => {
    await expectCustomProviderMergeResult({
      existingProviderKey: "custom",
      configProviderKey: " custom ",
      expectedApiKey: "AGENT_KEY",
      expectedBaseUrl: "https://config.example/v1",
    });
  });

  it("replaces stale merged baseUrl when the provider api changes", async () => {
    await expectCustomProviderMergeResult({
      seedProvider: createAgentSeedProvider({ api: "openai-completions" }),
      expectedApiKey: "AGENT_KEY",
      expectedBaseUrl: "https://config.example/v1",
    });
  });

  it("replaces stale merged baseUrl when only model-level apis change", async () => {
    await withTempHome(async () => {
      const parsed = await runCustomProviderMergeTest({
        seedProvider: {
          baseUrl: "https://agent.example/v1",
          apiKey: "AGENT_KEY", // pragma: allowlist secret
          api: "",
          models: [
            {
              id: "agent-model",
              name: "Agent model",
              input: ["text"],
              api: "openai-completions",
            },
          ],
        },
      });
      expect(parsed.providers.custom?.apiKey).toBe("AGENT_KEY");
      expect(parsed.providers.custom?.baseUrl).toBe("https://config.example/v1");
    });
  });

  it("replaces stale merged apiKey when provider is SecretRef-managed in current config", async () => {
    await expectCustomProviderApiKeyRewrite({
      existingApiKey: "STALE_AGENT_KEY", // pragma: allowlist secret
      configuredApiKey: {
        source: "env",
        provider: "default",
        id: "CUSTOM_PROVIDER_API_KEY", // pragma: allowlist secret
      },
      expectedApiKey: "CUSTOM_PROVIDER_API_KEY", // pragma: allowlist secret
    });
  });

  it("replaces stale merged apiKey when provider is SecretRef-managed via auth-profiles", async () => {
    await withTempHome(async () => {
      const agentDir = resolveOpenClawAgentDir();
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "auth-profiles.json"),
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "minimax:default": {
                type: "api_key",
                provider: "minimax",
                keyRef: { source: "env", provider: "default", id: "MINIMAX_API_KEY" }, // pragma: allowlist secret
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeAgentModelsJson({
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/anthropic",
            apiKey: "STALE_AGENT_KEY", // pragma: allowlist secret
            api: "anthropic-messages",
            models: [{ id: "MiniMax-M2.7", name: "MiniMax M2.7", input: ["text"] }],
          },
        },
      });

      await ensureOpenClawModelsJson({
        models: {
          mode: "merge",
          providers: {},
        },
      });

      const parsed = await readGeneratedModelsJson<{
        providers: Record<string, { apiKey?: string }>;
      }>();
      expect(parsed.providers.minimax?.apiKey).toBe("MINIMAX_API_KEY"); // pragma: allowlist secret
    });
  });

  it("replaces stale non-env marker when provider transitions back to plaintext config", async () => {
    await expectCustomProviderApiKeyRewrite({
      existingApiKey: NON_ENV_SECRETREF_MARKER,
      configuredApiKey: "ALLCAPS_SAMPLE", // pragma: allowlist secret
      expectedApiKey: "ALLCAPS_SAMPLE", // pragma: allowlist secret
    });
  });

  it("uses config apiKey/baseUrl when existing agent values are empty", async () => {
    await withTempHome(async () => {
      const parsed = await runCustomProviderMergeTest({
        seedProvider: {
          baseUrl: "",
          apiKey: "",
          api: "openai-responses",
          models: [{ id: "agent-model", name: "Agent model", input: ["text"] }],
        },
      });
      expect(parsed.providers.custom?.apiKey).toBe("CONFIG_KEY");
      expect(parsed.providers.custom?.baseUrl).toBe("https://config.example/v1");
    });
  });

  it("preserves explicit moonshot model capabilities when config already defines the model", async () => {
    await withTempHome(async () => {
      await withEnvVar("MOONSHOT_API_KEY", "sk-moonshot-test", async () => {
        const cfg = createMoonshotConfig({ contextWindow: 1024, maxTokens: 256 });

        await ensureOpenClawModelsJson(cfg);

        const parsed = await readGeneratedModelsJson<{
          providers: Record<
            string,
            {
              models?: Array<{
                id: string;
                input?: string[];
                reasoning?: boolean;
                contextWindow?: number;
                maxTokens?: number;
                cost?: { input?: number; output?: number };
              }>;
            }
          >;
        }>();
        const kimi = parsed.providers.moonshot?.models?.find((model) => model.id === "kimi-k2.5");
        expect(kimi?.input).toEqual(["text"]);
        expect(kimi?.reasoning).toBe(false);
        expect(kimi?.contextWindow).toBe(1024);
        expect(kimi?.maxTokens).toBe(256);
        // Preserve explicit user pricing overrides when refreshing capabilities.
        expect(kimi?.cost?.input).toBe(123);
        expect(kimi?.cost?.output).toBe(456);
      });
    });
  });

  it("does not persist resolved env var value as plaintext in models.json", async () => {
    await expectOpenAiEnvMarkerApiKey();
  });

  it("replaces stale merged apiKey when config key normalizes to a known env marker", async () => {
    await expectOpenAiEnvMarkerApiKey({ seedMergedProvider: true });
  });

  it("preserves explicit larger token limits when they exceed implicit catalog defaults", async () => {
    await expectMoonshotTokenLimits({
      contextWindow: 350000,
      maxTokens: 16384,
      expectedContextWindow: 350000,
      expectedMaxTokens: 16384,
    });
  });

  it("preserves explicit moonshot token limits even when they are invalid", async () => {
    await expectMoonshotTokenLimits({
      contextWindow: 0,
      maxTokens: -1,
      expectedContextWindow: 0,
      expectedMaxTokens: -1,
    });
  });
});
