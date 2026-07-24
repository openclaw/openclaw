// Coverage for embedded extension factory selection and runtime wiring.
import type { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
import contextPruningExtension from "../agent-hooks/context-pruning.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  // Plugin-owned cache-TTL decisions are mocked out here; extension selection
  // tests assert the core default wiring only.
  resolveProviderCacheTtlEligibility: () => undefined,
  resolveProviderRuntimePlugin: () => undefined,
}));

vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: () => undefined,
}));

const createAgentToolResultMiddlewareRunnerMock = vi.hoisted(() =>
  vi.fn((ctx: { runtime: string }) => ({
    applyToolResultMiddleware: async (event: { result: unknown }) => event.result,
    context: ctx,
  })),
);

vi.mock("../harness/tool-result-middleware.js", () => ({
  createAgentToolResultMiddlewareRunner: createAgentToolResultMiddlewareRunnerMock,
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

  it("forwards agent/session/run identity into OpenClaw tool-result middleware context", () => {
    createAgentToolResultMiddlewareRunnerMock.mockClear();
    const sessionManager = {
      getSessionId: () => "session-from-manager",
    } as SessionManager;

    buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      model: { id: "claude-sonnet-4-20250514", contextWindow: 200_000 } as Model,
      runId: "run-abc",
      agentId: "main",
      sessionId: "session-explicit",
      sessionKey: "agent:main:discord:group:1",
    });

    expect(createAgentToolResultMiddlewareRunnerMock).toHaveBeenCalledWith({
      runtime: "openclaw",
      agentId: "main",
      sessionId: "session-explicit",
      sessionKey: "agent:main:discord:group:1",
      runId: "run-abc",
    });
  });

  it("falls back to SessionManager.getSessionId when sessionId is omitted", () => {
    createAgentToolResultMiddlewareRunnerMock.mockClear();
    const sessionManager = {
      getSessionId: () => "session-from-manager",
    } as SessionManager;

    buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      model: { id: "claude-sonnet-4-20250514", contextWindow: 200_000 } as Model,
      runId: "run-def",
    });

    expect(createAgentToolResultMiddlewareRunnerMock).toHaveBeenCalledWith({
      runtime: "openclaw",
      sessionId: "session-from-manager",
      runId: "run-def",
    });
  });
});
