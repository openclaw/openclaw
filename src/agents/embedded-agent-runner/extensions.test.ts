import type { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  // Extension selection tests assert core defaults, not plugin cache-TTL policy.
  resolveProviderCacheTtlEligibility: () => undefined,
  resolveProviderRuntimePlugin: () => undefined,
}));

vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: () => undefined,
}));

type Compaction = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["compaction"]
>;

function buildSafeguardFactories(
  qualityGuard?: Compaction["qualityGuard"],
  workspaceDir = "/workspace",
) {
  // Runtime inspection must use the manager that owns the factories.
  const sessionManager = {} as SessionManager;
  const factories = buildEmbeddedExtensionFactories({
    cfg: { agents: { defaults: { compaction: { mode: "safeguard", qualityGuard } } } },
    sessionManager,
    workspaceDir,
    model: { id: "claude-sonnet-4-20250514", contextWindow: 200_000 } as Model,
  });
  return { factories, sessionManager };
}

function expectSafeguardRuntime(
  qualityGuard: Compaction["qualityGuard"],
  expectedRuntime: { qualityGuardEnabled: boolean; qualityGuardMaxRetries?: number },
) {
  const { factories, sessionManager } = buildSafeguardFactories(qualityGuard);
  expect(factories).toContain(compactionSafeguardExtension);
  const runtime = getCompactionSafeguardRuntime(sessionManager);
  expect(runtime?.qualityGuardEnabled).toBe(expectedRuntime.qualityGuardEnabled);
  expect(runtime?.qualityGuardMaxRetries).toBe(expectedRuntime.qualityGuardMaxRetries);
}

describe("buildEmbeddedExtensionFactories", () => {
  it("enables quality-guard retries by default in safeguard mode", () => {
    expectSafeguardRuntime(undefined, { qualityGuardEnabled: true });
  });

  it("honors explicit safeguard quality-guard disablement", () => {
    expectSafeguardRuntime({ enabled: false }, { qualityGuardEnabled: false });
  });

  it("wires explicit safeguard quality-guard runtime flags", () => {
    expectSafeguardRuntime(
      { enabled: true, maxRetries: 2 },
      { qualityGuardEnabled: true, qualityGuardMaxRetries: 2 },
    );
  });

  it("wires the run workspace into safeguard runtime", () => {
    const { sessionManager } = buildSafeguardFactories(undefined, "/tmp/openclaw-workspace");

    expect(getCompactionSafeguardRuntime(sessionManager)?.workspaceDir).toBe(
      "/tmp/openclaw-workspace",
    );
  });
});
