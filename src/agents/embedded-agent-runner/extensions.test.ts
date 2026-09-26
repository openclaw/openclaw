// Coverage for embedded extension factory selection and runtime wiring.
import type { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  getCompactionSafeguardRuntime,
  getCurrentCompactionSemanticMode,
} from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
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
  it.each([true, false])(
    "uses persisted owner eligibility instead of prepared agent (enabled=%s)",
    (ownerEnabled) => {
      const sessionManager = {
        getSessionTarget: () => ({
          agentId: "owner",
          sessionId: "id",
          sessionKey: "agent:owner:id",
          storePath: "/synthetic",
        }),
      } as SessionManager;
      buildEmbeddedExtensionFactories({
        cfg: {
          agents: {
            defaults: {
              experimental: { decisionAssistance: true },
              compaction: { mode: "safeguard", semanticCuration: { mode: "shadow" } },
            },
            entries: {
              owner: { decisionModel: ownerEnabled ? "fixture/owner" : "" },
              prepared: { decisionModel: ownerEnabled ? "" : "fixture/prepared" },
            },
          },
        },
        sessionManager,
        agentId: "prepared",
        provider: "fixture",
        modelId: "summary",
        model: undefined,
      });
      expect(getCompactionSafeguardRuntime(sessionManager)?.agentId).toBe("owner");
      expect(getCompactionSafeguardRuntime(sessionManager)?.semanticCurationMode).toBe(
        ownerEnabled ? "shadow" : "off",
      );
    },
  );

  it("dispatches under the resolved main owner when the session has no target", () => {
    const sessionManager = {} as SessionManager;
    buildEmbeddedExtensionFactories({
      cfg: {
        agents: {
          defaults: {
            experimental: { decisionAssistance: true },
            decisionModel: "global-provider/global-model",
            compaction: { mode: "safeguard", semanticCuration: { mode: "shadow" } },
          },
          entries: { main: { decisionModel: "owner-provider/owner-model" } },
        },
      },
      sessionManager,
      provider: "fixture",
      modelId: "summary",
      model: undefined,
    });
    const runtime = getCompactionSafeguardRuntime(sessionManager);
    expect(runtime?.semanticCurationMode).toBe("shadow");
    expect(runtime?.agentId).toBe("main");
  });

  it("uses the prepared context budget for safeguard sizing", () => {
    const sessionManager = {} as SessionManager;
    const factories = buildEmbeddedExtensionFactories({
      cfg: {
        agents: {
          defaults: { compaction: { mode: "safeguard" } },
        },
      } as OpenClawConfig,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      model: {
        id: "claude-sonnet-4-20250514",
        contextWindow: 272_000,
        contextTokens: 272_000,
      } as Model,
      contextTokenBudget: 128_000,
      agentId: "capped",
    });
    expect(factories).toContain(compactionSafeguardExtension);
    expect(getCompactionSafeguardRuntime(sessionManager)?.contextWindowTokens).toBe(128_000);
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

  it("wires shadow semantic curation into safeguard runtime", () => {
    const cfg = {
      agents: {
        defaults: {
          experimental: { decisionAssistance: true },
          decisionModel: "fixture/default",
          compaction: {
            mode: "safeguard",
            semanticCuration: {
              mode: "shadow",
              timeoutMs: 650,
            },
          },
        },
      },
    } as OpenClawConfig;
    const { sessionManager } = buildSafeguardFactories(cfg);

    expect(getCompactionSafeguardRuntime(sessionManager)?.semanticCurationMode).toBe("shadow");
    expect(getCompactionSafeguardRuntime(sessionManager)?.semanticCurationTimeoutMs).toBe(650);
    cfg.agents!.defaults!.compaction!.semanticCuration!.mode = "off";
    expect(getCurrentCompactionSemanticMode(sessionManager)).toBe("off");
  });

  it("keeps automatic semantic curation off without Decision assistance consent", () => {
    const cfg = {
      agents: {
        defaults: {
          decisionModel: "openai/gpt-5-mini",
          experimental: { decisionAssistance: false },
          compaction: { mode: "safeguard", semanticCuration: { mode: "apply" } },
        },
      },
    } as OpenClawConfig;
    const { sessionManager } = buildSafeguardFactories(cfg);
    const runtime = getCompactionSafeguardRuntime(sessionManager);
    expect(runtime?.semanticCurationMode).toBe("off");
    cfg.agents!.defaults!.experimental!.decisionAssistance = true;
    expect(runtime?.semanticCurationEligible?.()).toBe(true);
    expect(getCurrentCompactionSemanticMode(sessionManager)).toBe("off");
    cfg.agents!.defaults!.experimental!.decisionAssistance = false;
    expect(runtime?.semanticCurationEligible?.()).toBe(false);
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
});
