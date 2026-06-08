// Coverage for embedded extension factory selection and runtime wiring.
import type { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
import contextPruningExtension from "../agent-hooks/context-pruning.js";
import { buildEmbeddedExtensionFactories, resolveSafeguardRuntimeTarget } from "./extensions.js";

const mocks = vi.hoisted(() => ({
  log: {
    warn: vi.fn(),
  },
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  // Plugin-owned cache-TTL decisions are mocked out here; extension selection
  // tests assert the core default wiring only.
  resolveProviderCacheTtlEligibility: () => undefined,
  resolveProviderRuntimePlugin: () => undefined,
  runProviderDynamicModel: () => undefined,
  shouldPreferProviderRuntimeResolvedModel: () => false,
}));

vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: () => undefined,
}));

vi.mock("./logger.js", () => ({
  log: mocks.log,
}));

function buildSafeguardFactories(cfg: OpenClawConfig, workspaceDir?: string) {
  // The safeguard runtime attaches to the session manager, so tests keep the
  // same manager instance around for both factory construction and inspection.
  const sessionManager = {} as SessionManager;
  const model = {
    id: "claude-sonnet-4-20250514",
    contextWindow: 200_000,
  } as Model;

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

function createAnthropicModel(id: string): Model {
  return {
    id,
    name: id,
    provider: "anthropic",
    api: "anthropic",
    baseUrl: "https://api.anthropic.com",
    contextWindow: 200_000,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"],
  } as Model;
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
    mocks.log.warn.mockReset();
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

  it("resolves configured safeguard compaction model before registering runtime", () => {
    const sessionManager = {} as SessionManager;
    const sessionModel = createAnthropicModel("claude-opus-4-7");
    const compactionModel = createAnthropicModel("claude-sonnet-4-6");
    const modelRegistry = {
      find: vi.fn((provider: string, modelId: string) =>
        provider === "anthropic" && modelId === "claude-sonnet-4-6" ? compactionModel : null,
      ),
    };

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
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      model: sessionModel,
      modelRegistry: modelRegistry as unknown as ModelRegistry,
    });

    expect(modelRegistry.find).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-6");
    expect(getCompactionSafeguardRuntime(sessionManager)?.model).toMatchObject({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    });
  });

  it("resolves configured safeguard compaction model from inline provider config", () => {
    const sessionManager = {} as SessionManager;
    const sessionModel = createAnthropicModel("claude-opus-4-7");
    const modelRegistry = {
      find: vi.fn(() => null),
    };

    buildEmbeddedExtensionFactories({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              mode: "safeguard",
              model: "foo/custom-summary",
            },
          },
        },
        models: {
          providers: {
            foo: {
              baseUrl: "https://foo.example/v1",
              api: "openai-responses",
              models: [
                {
                  id: "custom-summary",
                  name: "Custom Summary",
                  contextWindow: 123_456,
                  maxTokens: 4096,
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      model: sessionModel,
      modelRegistry: modelRegistry as unknown as ModelRegistry,
    });

    const runtime = getCompactionSafeguardRuntime(sessionManager);
    expect(modelRegistry.find).not.toHaveBeenCalled();
    expect(runtime?.model).not.toBe(sessionModel);
    expect(runtime?.model).toMatchObject({
      provider: "foo",
      id: "custom-summary",
      api: "openai-responses",
      contextWindow: 123_456,
    });
    expect(runtime?.contextWindowTokens).toBe(123_456);
  });

  it("keeps the session model in safeguard runtime when no compaction model is configured", () => {
    const sessionManager = {} as SessionManager;
    const sessionModel = createAnthropicModel("claude-opus-4-7");

    buildEmbeddedExtensionFactories({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              mode: "safeguard",
            },
          },
        },
      } as OpenClawConfig,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      model: sessionModel,
    });

    expect(getCompactionSafeguardRuntime(sessionManager)?.model).toBe(sessionModel);
  });

  it("warns when configured safeguard compaction model is absent from registry", () => {
    const modelRegistry = {
      find: vi.fn(() => null),
    };

    const target = resolveSafeguardRuntimeTarget({
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
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      model: createAnthropicModel("claude-opus-4-7"),
      modelRegistry: modelRegistry as unknown as ModelRegistry,
    });

    expect(modelRegistry.find).toHaveBeenCalledWith("anthropic", "claude-typo-4-6");
    expect(target).toEqual({
      provider: "anthropic",
      modelId: "claude-typo-4-6",
      model: undefined,
    });
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'Configured safeguard compaction model "anthropic/claude-typo-4-6" could not be resolved against the model registry; using the session model when available, otherwise compaction will be skipped.',
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
