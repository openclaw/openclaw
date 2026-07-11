// Coverage for embedded extension factory selection and runtime wiring.
import type { ModelRegistry, SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
import contextPruningExtension from "../agent-hooks/context-pruning.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { AuthStorage, ModelRegistry as RuntimeModelRegistry } from "../sessions/index.js";
import { buildEmbeddedExtensionFactories, prepareSafeguardRuntimeTarget } from "./extensions.js";

const mocks = vi.hoisted(() => ({
  prepareProviderRuntimeAuth: vi.fn(),
  resolveModelWithRegistry: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  // Plugin-owned cache-TTL decisions are mocked out here; extension selection
  // tests assert the core default wiring only.
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  prepareProviderRuntimeAuth: mocks.prepareProviderRuntimeAuth,
  resolveProviderCacheTtlEligibility: () => undefined,
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
  resolveProviderRuntimePlugin: () => undefined,
  shouldDeferProviderSyntheticProfileAuthWithPlugin: () => false,
}));

vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: () => undefined,
}));

vi.mock("./logger.js", () => ({
  log: { warn: mocks.warn },
}));

vi.mock("./model.js", () => ({
  resolveModelWithRegistry: mocks.resolveModelWithRegistry,
}));

function createModel(provider: string, id: string, contextWindow = 200_000): Model {
  return {
    id,
    name: id,
    provider,
    api: provider === "anthropic" ? "anthropic-messages" : "openai-responses",
    baseUrl: `https://${provider}.example.test`,
    contextWindow,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"],
  } as Model;
}

function buildSafeguardFactories(cfg: OpenClawConfig, workspaceDir?: string) {
  // The safeguard runtime attaches to the session manager, so tests keep the
  // same manager instance around for both factory construction and inspection.
  const sessionManager = {} as SessionManager;
  const model = createModel("anthropic", "claude-sonnet-4-20250514");

  const factories = buildEmbeddedExtensionFactories({
    cfg,
    sessionManager,
    workspaceDir,
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    model,
  });

  return { factories, sessionManager };
}

function expectSafeguardRuntime(
  cfg: OpenClawConfig,
  expectedRuntime: { qualityGuardEnabled: boolean; qualityGuardMaxRetries?: number },
) {
  const { factories, sessionManager } = buildSafeguardFactories(cfg);

  expect(factories).toContain(compactionSafeguardExtension);
  const runtime = getCompactionSafeguardRuntime(sessionManager);
  expect(runtime?.contextWindowTokens).toBe(200_000);
  expect(runtime?.qualityGuardEnabled).toBe(expectedRuntime.qualityGuardEnabled);
  expect(runtime?.qualityGuardMaxRetries).toBe(expectedRuntime.qualityGuardMaxRetries);
}

describe("buildEmbeddedExtensionFactories", () => {
  beforeEach(() => {
    mocks.prepareProviderRuntimeAuth.mockReset();
    mocks.prepareProviderRuntimeAuth.mockResolvedValue(undefined);
    mocks.resolveModelWithRegistry.mockReset();
    mocks.warn.mockReset();
  });

  it("enables quality-guard retries by default in safeguard mode", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
          },
        },
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(cfg, {
      qualityGuardEnabled: true,
    });
  });

  it("honors explicit safeguard quality-guard disablement", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            qualityGuard: {
              enabled: false,
            },
          },
        },
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(cfg, {
      qualityGuardEnabled: false,
    });
  });

  it("wires explicit safeguard quality-guard runtime flags", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            qualityGuard: {
              enabled: true,
              maxRetries: 2,
            },
          },
        },
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(cfg, {
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 2,
    });
  });

  it("registers the configured safeguard compaction model", () => {
    const sessionManager = {} as SessionManager;
    const sessionModel = createModel("anthropic", "claude-opus-4-6");
    const compactionModel = createModel("openai", "gpt-5.6-luna", 128_000);
    const modelRegistry = {} as ModelRegistry;
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            model: "openai/gpt-5.6-luna",
          },
        },
      },
    } as OpenClawConfig;
    mocks.resolveModelWithRegistry.mockReturnValueOnce(compactionModel);

    buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      model: sessionModel,
      modelRegistry,
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      authProfileId: "anthropic:default",
      harnessRuntime: "openclaw",
    });

    expect(mocks.resolveModelWithRegistry).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      modelRegistry,
      cfg,
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      authProfileId: undefined,
    });
    expect(getCompactionSafeguardRuntime(sessionManager)).toMatchObject({
      model: compactionModel,
      contextWindowTokens: 128_000,
    });
  });

  it("binds profile-only auth before registering a cross-provider safeguard model", async () => {
    const sessionManager = {} as SessionManager;
    const sessionModel = createModel("anthropic", "claude-opus-4-6");
    const compactionModel = createModel("openai", "gpt-5.6-luna", 128_000);
    const authStorage = AuthStorage.inMemory({
      anthropic: { type: "api_key", key: "active-anthropic-key" },
    });
    const modelRegistry = RuntimeModelRegistry.inMemory(authStorage);
    const authProfileStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:compaction": {
          type: "api_key",
          provider: "openai",
          key: "profile-only-openai-key",
        },
      },
    };
    const cfg = {
      auth: {
        order: {
          openai: ["openai:compaction"],
        },
      },
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            model: "openai/gpt-5.6-luna",
          },
        },
      },
    } as OpenClawConfig;
    mocks.resolveModelWithRegistry.mockReturnValueOnce(compactionModel);

    const safeguardRuntimeTarget = await prepareSafeguardRuntimeTarget({
      cfg,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      model: sessionModel,
      modelRegistry,
      authStorage,
      authProfileStore,
      authProfileId: "anthropic:default",
    });
    buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      model: sessionModel,
      modelRegistry,
      authProfileId: "anthropic:default",
      safeguardRuntimeTarget,
    });

    const boundAuth = await modelRegistry.getApiKeyAndHeaders(compactionModel);
    expect(boundAuth).toMatchObject({ ok: true, apiKey: "profile-only-openai-key" });
    expect(safeguardRuntimeTarget?.authProfileId).toBe("openai:compaction");
    expect(getCompactionSafeguardRuntime(sessionManager)).toMatchObject({
      model: compactionModel,
      contextWindowTokens: 128_000,
    });
  });

  it("warns and keeps the active model when cross-provider safeguard auth is missing", async () => {
    const sessionManager = {} as SessionManager;
    const sessionModel = createModel("anthropic", "claude-opus-4-6");
    const compactionModel = createModel("missing-target", "summary-model", 128_000);
    const authStorage = AuthStorage.inMemory({
      anthropic: { type: "api_key", key: "active-anthropic-key" },
    });
    const modelRegistry = RuntimeModelRegistry.inMemory(authStorage);
    mocks.resolveModelWithRegistry.mockReturnValueOnce(compactionModel);

    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            model: "missing-target/summary-model",
          },
        },
      },
    } as OpenClawConfig;
    const safeguardRuntimeTarget = await prepareSafeguardRuntimeTarget({
      cfg,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      model: sessionModel,
      modelRegistry,
      authStorage,
      authProfileStore: { version: 1, profiles: {} },
      authProfileId: "anthropic:default",
    });
    buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      model: sessionModel,
      modelRegistry,
      authProfileId: "anthropic:default",
      safeguardRuntimeTarget,
    });

    const missingAuth = await modelRegistry.getApiKeyAndHeaders(compactionModel);
    expect(missingAuth).toMatchObject({ ok: true, apiKey: undefined });
    expect(getCompactionSafeguardRuntime(sessionManager)?.model).toBe(sessionModel);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Configured safeguard compaction model "missing-target/summary-model" auth could not be prepared',
      ),
    );
  });

  it("keeps the pinned session model when model selection is locked to a native harness", () => {
    const sessionManager = {} as SessionManager;
    const sessionModel = createModel("openai", "gpt-5.5");

    buildEmbeddedExtensionFactories({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              mode: "safeguard",
              model: "anthropic/claude-sonnet-4-6",
            },
          },
        },
      } as OpenClawConfig,
      sessionManager,
      provider: "openai",
      modelId: "gpt-5.5",
      model: sessionModel,
      modelRegistry: {} as ModelRegistry,
      harnessRuntime: "codex",
      modelSelectionLocked: true,
    });

    expect(mocks.resolveModelWithRegistry).not.toHaveBeenCalled();
    expect(getCompactionSafeguardRuntime(sessionManager)?.model).toBe(sessionModel);
  });

  it("warns and keeps the session model when the configured model cannot be resolved", () => {
    const sessionManager = {} as SessionManager;
    const sessionModel = createModel("anthropic", "claude-opus-4-6");
    mocks.resolveModelWithRegistry.mockReturnValueOnce(undefined);

    buildEmbeddedExtensionFactories({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              mode: "safeguard",
              model: "anthropic/claude-typo-4-6",
            },
          },
        },
      } as OpenClawConfig,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      model: sessionModel,
      modelRegistry: {} as ModelRegistry,
    });

    expect(getCompactionSafeguardRuntime(sessionManager)?.model).toBe(sessionModel);
    expect(mocks.warn).toHaveBeenCalledWith(
      'Configured safeguard compaction model "anthropic/claude-typo-4-6" could not be resolved; using the active session model when available, otherwise safeguard compaction will be skipped.',
    );
  });

  it("wires the run workspace into safeguard runtime", () => {
    const { sessionManager } = buildSafeguardFactories(
      {
        agents: {
          defaults: {
            compaction: {
              mode: "safeguard",
            },
          },
        },
      } as OpenClawConfig,
      "/tmp/openclaw-workspace",
    );

    expect(getCompactionSafeguardRuntime(sessionManager)?.workspaceDir).toBe(
      "/tmp/openclaw-workspace",
    );
  });

  it("enables cache-ttl pruning for custom anthropic-messages providers", () => {
    const factories = buildEmbeddedExtensionFactories({
      cfg: {
        agents: {
          defaults: {
            contextPruning: {
              mode: "cache-ttl",
            },
          },
        },
      } as OpenClawConfig,
      sessionManager: {} as SessionManager,
      provider: "litellm",
      modelId: "claude-sonnet-4-6",
      model: { api: "anthropic-messages", contextWindow: 200_000 } as Model,
    });

    expect(factories).toContain(contextPruningExtension);
  });
});
