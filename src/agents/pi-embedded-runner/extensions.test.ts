import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getCompactionSafeguardRuntime } from "../pi-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../pi-hooks/compaction-safeguard.js";
import contextPruningExtension from "../pi-hooks/context-pruning.js";
import { buildEmbeddedExtensionFactories, resolveSafeguardRuntimeTarget } from "./extensions.js";

const mocks = vi.hoisted(() => ({
  log: {
    warn: vi.fn(),
  },
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveProviderCacheTtlEligibility: () => undefined,
  resolveProviderRuntimePlugin: () => undefined,
}));

vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: () => undefined,
}));

vi.mock("./logger.js", () => ({
  log: mocks.log,
}));

function buildSafeguardFactories(cfg: OpenClawConfig) {
  const sessionManager = {} as SessionManager;
  const model = {
    id: "claude-sonnet-4-20250514",
    contextWindow: 200_000,
  } as Model<Api>;

  const factories = buildEmbeddedExtensionFactories({
    cfg,
    sessionManager,
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    model,
  });

  return { factories, sessionManager };
}

function createAnthropicModel(id: string): Model<Api> {
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
  } as Model<Api>;
}

function expectSafeguardRuntime(
  cfg: OpenClawConfig,
  expectedRuntime: { qualityGuardEnabled: boolean; qualityGuardMaxRetries?: number },
) {
  const { factories, sessionManager } = buildSafeguardFactories(cfg);

  expect(factories).toContain(compactionSafeguardExtension);
  expect(getCompactionSafeguardRuntime(sessionManager)).toMatchObject(expectedRuntime);
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
      'Configured safeguard compaction model "anthropic/claude-typo-4-6" was not found in the model registry; falling back to the session model.',
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
      model: { api: "anthropic-messages", contextWindow: 200_000 } as Model<Api>,
    });

    expect(factories).toContain(contextPruningExtension);
  });
});
