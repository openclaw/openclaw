import assert from "node:assert/strict";
import path from "node:path";
import { Command } from "commander";
import type { ProviderAuthMethodNonInteractiveContext } from "openclaw/plugin-sdk/plugin-entry";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { DEFAULT_LLAMA_CPP_EMBEDDING_MODEL } from "./defaults.js";
import { mocks, tempRoot } from "./setup.test-support.js";

const { default: plugin } = await import("../index.js");
const localChoice =
  manifest.providerAuthChoices.find((choice) => choice.method === "local") ??
  assert.fail("managed llama.cpp must declare its local auth choice");

function setupContext(): ProviderAuthMethodNonInteractiveContext {
  return {
    authChoice: "llama-cpp",
    config: { memory: { search: { provider: "local" } } },
    baseConfig: {},
    opts: new Command()
      .exitOverride()
      .option(localChoice.cliOption)
      .parse([localChoice.cliFlag], { from: "user" })
      .opts<Record<string, unknown>>(),
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    resolveApiKey: vi.fn(),
    toApiKeyCredential: vi.fn(),
  };
}

async function setup(ctx: ProviderAuthMethodNonInteractiveContext) {
  const { api, providers } = createCapturedPluginRegistration({ id: "test-plugin" });
  plugin.register(api);
  const method = providers
    .find((provider) => provider.id === "llama-cpp")
    ?.auth.find((entry) => entry.id === "local");
  assert(method?.runNonInteractive, "managed llama.cpp must support non-interactive setup");
  return await method.runNonInteractive(ctx);
}

describe("managed llama.cpp non-interactive onboarding", () => {
  it.each([undefined, false, "true"])(
    "requires explicit boolean download consent (%s)",
    async (consent) => {
      const ctx = setupContext();
      ctx.opts.llamaCppEmbeddingOnly = consent;
      await expect(setup(ctx)).rejects.toThrow("--llama-cpp-embedding-only");
      expect(mocks.ensureServerInstalled).not.toHaveBeenCalled();
      expect(mocks.ensureModel).not.toHaveBeenCalled();
    },
  );

  it("downloads only embeddings and preserves chat, unrelated providers and auth bindings", async () => {
    const ctx = setupContext();
    expect(ctx.opts).toEqual({ [localChoice.optionKey]: true });
    ctx.config.agents = { defaults: { model: { primary: "openai/gpt-5.4" } } };
    ctx.config.models = {
      providers: { other: { baseUrl: "http://localhost:8080/v1", models: [] } },
    };
    ctx.config.auth = {
      profiles: {
        "llama-cpp:default": { provider: "llama-cpp", mode: "api_key" },
        "other:default": { provider: "other", mode: "api_key" },
      },
      order: { "llama-cpp": ["llama-cpp:default"], other: ["other:default"] },
    };

    const result = await setup(ctx);

    expect(result?.models?.providers?.["llama-cpp"]).toMatchObject({
      baseUrl: "http://127.0.0.1:19432/v1",
      api: "openai-completions",
      models: [],
      localService: { command: path.join(tempRoot, "llama-server") },
    });
    expect(result?.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.4" });
    expect(result?.models?.providers?.other).toEqual({
      baseUrl: "http://localhost:8080/v1",
      models: [],
    });
    expect(result?.auth).toEqual({
      profiles: { "other:default": { provider: "other", mode: "api_key" } },
      order: { other: ["other:default"] },
    });
    expect(ctx.config.auth.profiles?.["llama-cpp:default"]).toBeDefined();
    expect(mocks.ensureModel).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        source: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
        download: true,
      }),
    );
  });

  it("uses the enabled agent's configured embedding model", async () => {
    const ctx = setupContext();
    ctx.config = {
      agents: {
        entries: {
          research: {
            memory: {
              search: {
                provider: "local",
                local: { modelPath: "/models/custom-embedding.gguf" },
              },
            },
          },
        },
      },
    };
    await setup(ctx);
    expect(mocks.ensureModel).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        source: "/models/custom-embedding.gguf",
        download: true,
      }),
    );
  });

  it.each([
    { name: "unconfigured local memory", config: {}, error: "Set memory.search.provider" },
    {
      name: "disabled local memory",
      config: { memory: { search: { enabled: false, provider: "local" as const } } },
      error: "Set memory.search.provider",
    },
    {
      name: "external server",
      config: {
        memory: { search: { provider: "local" as const } },
        models: { providers: { "llama-cpp": { baseUrl: "http://localhost:8080/v1", models: [] } } },
      },
      error: "Embedding-only setup cannot replace",
    },
    {
      name: "managed chat server",
      config: {
        memory: { search: { provider: "local" as const } },
        models: {
          providers: {
            "llama-cpp": {
              baseUrl: "http://localhost:8080/v1",
              localService: { command: "/runtime/llama-server" },
              models: [
                {
                  id: "chat",
                  name: "Chat",
                  reasoning: false,
                  input: ["text" as const],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 512,
                },
              ],
            },
          },
        },
      },
      error: "Embedding-only setup cannot replace",
    },
    {
      name: "conflicting embedding models",
      config: {
        memory: { search: { provider: "local" as const } },
        agents: {
          entries: {
            alpha: { memory: { search: { local: { modelPath: "/models/alpha.gguf" } } } },
            beta: { memory: { search: { local: { modelPath: "/models/beta.gguf" } } } },
          },
        },
      },
      error: "Configured agents resolve to different",
    },
  ])("rejects $name before downloads", async ({ config, error }) => {
    const ctx = setupContext();
    ctx.config = config;
    await expect(setup(ctx)).rejects.toThrow(error);
    expect(mocks.ensureServerInstalled).not.toHaveBeenCalled();
    expect(mocks.ensureModel).not.toHaveBeenCalled();
  });
});
