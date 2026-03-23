import type { Api, Model } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getCompactionSafeguardRuntime } from "../pi-extensions/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../pi-extensions/compaction-safeguard.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";

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

    const factories = buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      model,
    });

    expect(factories).toContain(compactionSafeguardExtension);
    expect(getCompactionSafeguardRuntime(sessionManager)).toMatchObject({
      compactionMode: "safeguard",
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

    const factories = buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      model,
    });

    expect(factories).toContain(compactionSafeguardExtension);
    expect(getCompactionSafeguardRuntime(sessionManager)).toMatchObject({
      compactionMode: "safeguard",
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 2,
    });
  });

  it("enables the compaction extension in default mode when strict targetTokens are configured", () => {
    const sessionManager = {} as SessionManager;
    const model = {
      id: "claude-sonnet-4-20250514",
      contextWindow: 200_000,
    } as Model<Api>;
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "default",
            targetTokens: 64_000,
          },
        },
      },
    } as OpenClawConfig;

    const factories = buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      model,
    });

    expect(factories).toContain(compactionSafeguardExtension);
    expect(getCompactionSafeguardRuntime(sessionManager)).toMatchObject({
      compactionMode: "default",
      contextWindowTokens: 200_000,
      targetTokens: 64_000,
    });
  });
});
