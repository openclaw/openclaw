import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ContextEngine, ContextEngineInfo } from "../../context-engine/types.js";
import { getCompactionInterceptRuntime } from "../pi-hooks/compaction-intercept-runtime.js";
import compactionInterceptExtension from "../pi-hooks/compaction-intercept.js";
import { getCompactionSafeguardRuntime } from "../pi-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../pi-hooks/compaction-safeguard.js";
import contextPruningExtension from "../pi-hooks/context-pruning.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveProviderCacheTtlEligibility: () => undefined,
  resolveProviderRuntimePlugin: () => undefined,
}));

vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: () => undefined,
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

function makeEngine(info: ContextEngineInfo): ContextEngine {
  return {
    info,
    ingest: vi.fn(async () => ({ ingested: true })),
    assemble: vi.fn(async () => ({ messages: [], estimatedTokens: 0 })),
    compact: vi.fn(async () => ({ ok: true, compacted: false })),
    interceptCompaction: vi.fn(async () => ({ handled: false, reason: "noop" })),
  } as unknown as ContextEngine;
}

describe("buildEmbeddedExtensionFactories — compactionInterceptExtension wiring", () => {
  const baseParams = {
    cfg: undefined as OpenClawConfig | undefined,
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    model: { contextWindow: 258_000 } as Model<Api>,
  };

  it("does NOT register intercept when no activeContextEngine is supplied", () => {
    const sessionManager = {} as SessionManager;
    const factories = buildEmbeddedExtensionFactories({
      ...baseParams,
      sessionManager,
      activeContextEngine: undefined,
    });
    expect(factories).not.toContain(compactionInterceptExtension);
    expect(getCompactionInterceptRuntime(sessionManager)).toBeNull();
  });

  it("does NOT register intercept when engine info does not set interceptsCompaction", () => {
    const sessionManager = {} as SessionManager;
    const engine = makeEngine({ id: "legacy", name: "Legacy" });
    const factories = buildEmbeddedExtensionFactories({
      ...baseParams,
      sessionManager,
      activeContextEngine: engine,
    });
    expect(factories).not.toContain(compactionInterceptExtension);
    expect(getCompactionInterceptRuntime(sessionManager)).toBeNull();
  });

  it("DOES register intercept when engine info advertises interceptsCompaction", () => {
    const sessionManager = {} as SessionManager;
    const engine = makeEngine({ id: "lcm", name: "LCM", interceptsCompaction: true });
    const factories = buildEmbeddedExtensionFactories({
      ...baseParams,
      sessionManager,
      activeContextEngine: engine,
    });
    expect(factories).toContain(compactionInterceptExtension);
    const runtime = getCompactionInterceptRuntime(sessionManager);
    expect(runtime?.contextEngine).toBe(engine);
  });

  it("threads sessionKey into the intercept runtime when supplied", () => {
    const sessionManager = {} as SessionManager;
    const engine = makeEngine({ id: "lcm", name: "LCM", interceptsCompaction: true });
    buildEmbeddedExtensionFactories({
      ...baseParams,
      sessionManager,
      activeContextEngine: engine,
      sessionKey: "agent:main:main",
    });
    const runtime = getCompactionInterceptRuntime(sessionManager);
    expect(runtime?.sessionKey).toBe("agent:main:main");
  });

  it("registers intercept with undefined sessionKey when not supplied (back-compat)", () => {
    const sessionManager = {} as SessionManager;
    const engine = makeEngine({ id: "lcm", name: "LCM", interceptsCompaction: true });
    buildEmbeddedExtensionFactories({
      ...baseParams,
      sessionManager,
      activeContextEngine: engine,
      // sessionKey intentionally omitted
    });
    const runtime = getCompactionInterceptRuntime(sessionManager);
    expect(runtime?.sessionKey).toBeUndefined();
    expect(runtime?.contextEngine).toBe(engine);
  });

  it("does NOT register intercept when engine ownsCompaction (engine bypasses SDK event)", () => {
    const sessionManager = {} as SessionManager;
    const engine = makeEngine({
      id: "owns-compaction",
      name: "Owns",
      ownsCompaction: true,
      interceptsCompaction: true,
    });
    const factories = buildEmbeddedExtensionFactories({
      ...baseParams,
      sessionManager,
      activeContextEngine: engine,
    });
    expect(factories).not.toContain(compactionInterceptExtension);
    expect(getCompactionInterceptRuntime(sessionManager)).toBeNull();
  });

  it("intercept factory is pushed AFTER safeguard factory (last-truthy-wins ordering)", () => {
    const cfg = {
      agents: { defaults: { compaction: { mode: "safeguard" } } },
    } as OpenClawConfig;
    const sessionManager = {} as SessionManager;
    const engine = makeEngine({ id: "lcm", name: "LCM", interceptsCompaction: true });
    const factories = buildEmbeddedExtensionFactories({
      ...baseParams,
      cfg,
      sessionManager,
      activeContextEngine: engine,
    });
    const safeguardIndex = factories.indexOf(compactionSafeguardExtension);
    const interceptIndex = factories.indexOf(compactionInterceptExtension);
    expect(safeguardIndex).toBeGreaterThanOrEqual(0);
    expect(interceptIndex).toBeGreaterThanOrEqual(0);
    expect(interceptIndex).toBeGreaterThan(safeguardIndex);
  });
});
