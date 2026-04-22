import type { Api, Model } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
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

function buildSafeguardFactories(cfg: OpenClawConfig, agentId?: string) {
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
    agentId,
  });

  return { factories, sessionManager };
}

function expectSafeguardRuntime(
  cfg: OpenClawConfig,
  expectedRuntime: {
    qualityGuardEnabled: boolean;
    qualityGuardMaxRetries?: number;
    customInstructions?: string;
  },
  agentId?: string,
) {
  const { factories, sessionManager } = buildSafeguardFactories(cfg, agentId);

  expect(factories).toContain(compactionSafeguardExtension);
  expect(getCompactionSafeguardRuntime(sessionManager)).toMatchObject(expectedRuntime);
}

describe("buildEmbeddedExtensionFactories", () => {
  it("does not opt safeguard mode into quality-guard retries", () => {
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

  it("prefers per-agent compaction custom instructions over defaults", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            customInstructions: "Global compaction guidance.",
          },
        },
        list: [
          {
            id: "writer",
            compaction: {
              customInstructions: "Keep editorial decisions and pending asks.",
            },
          },
        ],
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(
      cfg,
      {
        qualityGuardEnabled: false,
        customInstructions: "Keep editorial decisions and pending asks.",
      },
      "writer",
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
