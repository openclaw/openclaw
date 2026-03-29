import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveAuthProfileStore } from "./auth-profiles.js";
import { discoverAuthStorage, discoverModels } from "./pi-model-discovery.js";

async function createAgentDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-auth-storage-"));
}

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = await createAgentDir();
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await fs.stat(pathname);
    return true;
  } catch {
    return false;
  }
}

function writeRuntimeOpenRouterProfile(agentDir: string): void {
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          key: "sk-or-v1-runtime",
        },
      },
    },
    agentDir,
  );
}

async function writeLegacyAuthJson(
  agentDir: string,
  authEntries: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify(authEntries, null, 2));
}

async function readLegacyAuthJson(agentDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

async function writeModelsJson(agentDir: string, payload: unknown): Promise<void> {
  await fs.writeFile(path.join(agentDir, "models.json"), `${JSON.stringify(payload, null, 2)}\n`);
}

describe("discoverAuthStorage", () => {
  it("loads runtime credentials from auth-profiles without writing auth.json", async () => {
    await withAgentDir(async (agentDir) => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openrouter:default": {
              type: "api_key",
              provider: "openrouter",
              key: "sk-or-v1-runtime",
            },
            "anthropic:default": {
              type: "token",
              provider: "anthropic",
              token: "sk-ant-runtime",
            },
            "openai-codex:default": {
              type: "oauth",
              provider: "openai-codex",
              access: "oauth-access",
              refresh: "oauth-refresh",
              expires: Date.now() + 60_000,
            },
          },
        },
        agentDir,
      );

      const authStorage = discoverAuthStorage(agentDir);

      expect(authStorage.hasAuth("openrouter")).toBe(true);
      expect(authStorage.hasAuth("anthropic")).toBe(true);
      expect(authStorage.hasAuth("openai-codex")).toBe(true);
      await expect(authStorage.getApiKey("openrouter")).resolves.toBe("sk-or-v1-runtime");
      await expect(authStorage.getApiKey("anthropic")).resolves.toBe("sk-ant-runtime");
      expect(authStorage.get("openai-codex")).toMatchObject({
        type: "oauth",
        access: "oauth-access",
      });

      expect(await pathExists(path.join(agentDir, "auth.json"))).toBe(false);
    });
  });

  it("scrubs static api_key entries from legacy auth.json and keeps oauth entries", async () => {
    await withAgentDir(async (agentDir) => {
      writeRuntimeOpenRouterProfile(agentDir);
      await writeLegacyAuthJson(agentDir, {
        openrouter: { type: "api_key", key: "legacy-static-key" },
        "openai-codex": {
          type: "oauth",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      });

      discoverAuthStorage(agentDir);

      const parsed = await readLegacyAuthJson(agentDir);
      expect(parsed.openrouter).toBeUndefined();
      expect(parsed["openai-codex"]).toMatchObject({
        type: "oauth",
        access: "oauth-access",
      });
    });
  });

  it("preserves legacy auth.json when auth store is forced read-only", async () => {
    await withAgentDir(async (agentDir) => {
      const previous = process.env.OPENCLAW_AUTH_STORE_READONLY;
      process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
      try {
        writeRuntimeOpenRouterProfile(agentDir);
        await writeLegacyAuthJson(agentDir, {
          openrouter: { type: "api_key", key: "legacy-static-key" },
        });

        discoverAuthStorage(agentDir);

        const parsed = await readLegacyAuthJson(agentDir);
        expect(parsed.openrouter).toMatchObject({ type: "api_key", key: "legacy-static-key" });
      } finally {
        if (previous === undefined) {
          delete process.env.OPENCLAW_AUTH_STORE_READONLY;
        } else {
          process.env.OPENCLAW_AUTH_STORE_READONLY = previous;
        }
      }
    });
  });

  it("includes env-backed provider auth when no auth profile exists", async () => {
    await withAgentDir(async (agentDir) => {
      const previous = process.env.MISTRAL_API_KEY;
      process.env.MISTRAL_API_KEY = "mistral-env-test-key";
      try {
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {},
          },
          agentDir,
        );

        const authStorage = discoverAuthStorage(agentDir);

        expect(authStorage.hasAuth("mistral")).toBe(true);
        await expect(authStorage.getApiKey("mistral")).resolves.toBe("mistral-env-test-key");
      } finally {
        if (previous === undefined) {
          delete process.env.MISTRAL_API_KEY;
        } else {
          process.env.MISTRAL_API_KEY = previous;
        }
      }
    });
  });

  it("normalizes discovered Mistral compat flags for direct callers", async () => {
    await withAgentDir(async (agentDir) => {
      const previous = process.env.MISTRAL_API_KEY;
      process.env.MISTRAL_API_KEY = "mistral-env-test-key";
      try {
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {},
          },
          agentDir,
        );
        await writeModelsJson(agentDir, {
          providers: {
            mistral: {
              api: "openai-completions",
              baseUrl: "https://api.mistral.ai/v1",
              apiKey: "MISTRAL_API_KEY",
              models: [
                {
                  id: "mistral-large-latest",
                  name: "Mistral Large",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 262144,
                  maxTokens: 16384,
                },
              ],
            },
          },
        });

        const authStorage = discoverAuthStorage(agentDir);
        const modelRegistry = discoverModels(authStorage, agentDir);
        expect(modelRegistry.getError?.()).toBeUndefined();
        const model = modelRegistry.find("mistral", "mistral-large-latest") as {
          api?: string;
          compat?: {
            supportsStore?: boolean;
            supportsReasoningEffort?: boolean;
            maxTokensField?: string;
          };
        } | null;
        const all = modelRegistry.getAll() as Array<{
          provider?: string;
          id?: string;
          api?: string;
          compat?: {
            supportsStore?: boolean;
            supportsReasoningEffort?: boolean;
            maxTokensField?: string;
          };
        }>;
        const available = modelRegistry.getAvailable() as Array<{
          provider?: string;
          id?: string;
          api?: string;
          compat?: {
            supportsStore?: boolean;
            supportsReasoningEffort?: boolean;
            maxTokensField?: string;
          };
        }>;
        const fromAll = all.find(
          (entry) => entry.provider === "mistral" && entry.id === "mistral-large-latest",
        );
        const fromAvailable = available.find(
          (entry) => entry.provider === "mistral" && entry.id === "mistral-large-latest",
        );

        expect(model?.api).toBe("openai-completions");
        expect(fromAll?.api).toBe("openai-completions");
        expect(fromAvailable?.api).toBe("openai-completions");
        expect(model?.compat?.supportsStore).toBe(false);
        expect(model?.compat?.supportsReasoningEffort).toBe(false);
        expect(model?.compat?.maxTokensField).toBe("max_tokens");
        expect(fromAll?.compat?.supportsStore).toBe(false);
        expect(fromAll?.compat?.supportsReasoningEffort).toBe(false);
        expect(fromAll?.compat?.maxTokensField).toBe("max_tokens");
        expect(fromAvailable?.compat?.supportsStore).toBe(false);
        expect(fromAvailable?.compat?.supportsReasoningEffort).toBe(false);
        expect(fromAvailable?.compat?.maxTokensField).toBe("max_tokens");
      } finally {
        if (previous === undefined) {
          delete process.env.MISTRAL_API_KEY;
        } else {
          process.env.MISTRAL_API_KEY = previous;
        }
      }
    });
  });

  it("normalizes discovered Mistral compat flags for custom Mistral-hosted providers", async () => {
    await withAgentDir(async (agentDir) => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "custom-api-mistral-ai:default": {
              type: "api_key",
              provider: "custom-api-mistral-ai",
              key: "mistral-custom-key",
            },
          },
        },
        agentDir,
      );
      await writeModelsJson(agentDir, {
        providers: {
          "custom-api-mistral-ai": {
            api: "openai-completions",
            baseUrl: "https://api.mistral.ai/v1",
            apiKey: "custom-api-mistral-ai",
            models: [
              {
                id: "mistral-small-latest",
                name: "Mistral Small",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 16384,
              },
            ],
          },
        },
      });

      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir);
      const model = modelRegistry.find("custom-api-mistral-ai", "mistral-small-latest") as {
        compat?: {
          supportsStore?: boolean;
          supportsReasoningEffort?: boolean;
          maxTokensField?: string;
        };
      } | null;

      expect(model?.compat?.supportsStore).toBe(false);
      expect(model?.compat?.supportsReasoningEffort).toBe(false);
      expect(model?.compat?.maxTokensField).toBe("max_tokens");
    });
  });

  it("normalizes discovered Mistral compat flags for OpenRouter Mistral model ids", async () => {
    await withAgentDir(async (agentDir) => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openrouter:default": {
              type: "api_key",
              provider: "openrouter",
              key: "sk-or-v1-runtime",
            },
          },
        },
        agentDir,
      );
      await writeModelsJson(agentDir, {
        providers: {
          openrouter: {
            api: "openai-completions",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "OPENROUTER_API_KEY",
            models: [
              {
                id: "mistralai/mistral-small-3.2-24b-instruct",
                name: "Mistral Small via OpenRouter",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 16384,
              },
            ],
          },
        },
      });

      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir);
      const model = modelRegistry.find(
        "openrouter",
        "mistralai/mistral-small-3.2-24b-instruct",
      ) as {
        compat?: {
          supportsStore?: boolean;
          supportsReasoningEffort?: boolean;
          maxTokensField?: string;
        };
      } | null;

      expect(model?.compat?.supportsStore).toBe(false);
      expect(model?.compat?.supportsReasoningEffort).toBe(false);
      expect(model?.compat?.maxTokensField).toBe("max_tokens");
    });
  });

  it("normalizes discovered xAI compat flags for OpenRouter x-ai model ids", async () => {
    await withAgentDir(async (agentDir) => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openrouter:default": {
              type: "api_key",
              provider: "openrouter",
              key: "sk-or-v1-runtime",
            },
          },
        },
        agentDir,
      );
      await writeModelsJson(agentDir, {
        providers: {
          openrouter: {
            api: "openai-completions",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "OPENROUTER_API_KEY",
            models: [
              {
                id: "x-ai/grok-4.1-fast",
                name: "Grok via OpenRouter",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 256000,
                maxTokens: 8192,
              },
            ],
          },
        },
      });

      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir);
      const model = modelRegistry.find("openrouter", "x-ai/grok-4.1-fast") as {
        compat?: {
          toolSchemaProfile?: string;
          nativeWebSearchTool?: boolean;
          toolCallArgumentsEncoding?: string;
        };
      } | null;

      expect(model?.compat?.toolSchemaProfile).toBe("xai");
      expect(model?.compat?.nativeWebSearchTool).toBe(true);
      expect(model?.compat?.toolCallArgumentsEncoding).toBe("html-entities");
    });
  });

  it("normalizes discovered custom xAI-compatible providers by host", async () => {
    await withAgentDir(async (agentDir) => {
      await writeModelsJson(agentDir, {
        providers: {
          "custom-xai": {
            api: "openai-completions",
            baseUrl: "https://api.x.ai/v1",
            apiKey: "XAI_API_KEY",
            models: [
              {
                id: "grok-4.1-fast",
                name: "Custom Grok",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 256000,
                maxTokens: 8192,
              },
            ],
          },
        },
      });

      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir);
      const model = modelRegistry
        .getAll()
        .find((entry) => entry.provider === "custom-xai" && entry.id === "grok-4.1-fast") as
        | {
            api?: string;
            compat?: {
              toolSchemaProfile?: string;
              nativeWebSearchTool?: boolean;
              toolCallArgumentsEncoding?: string;
            };
          }
        | undefined;

      expect(model?.api).toBe("openai-responses");
      expect(model?.compat?.toolSchemaProfile).toBe("xai");
      expect(model?.compat?.nativeWebSearchTool).toBe(true);
      expect(model?.compat?.toolCallArgumentsEncoding).toBe("html-entities");
    });
  });
});
