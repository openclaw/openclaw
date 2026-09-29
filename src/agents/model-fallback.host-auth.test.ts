import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses, registerAgentHarness } from "./harness/registry.js";
import { resolveModelFallbackCandidateHarnessAuthPrecheck } from "./model-fallback-attempt.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { createModelFallbackConfig } from "./test-helpers/model-fallback-config-fixture.js";

const authRuntime = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(() => ({
    version: 1,
    profiles: {
      "fixture-provider:stale": {
        type: "api_key",
        provider: "fixture-provider",
        key: "fixture-key",
      },
    },
    usageStats: {
      "fixture-provider:stale": {
        disabledUntil: Date.now() + 60_000,
        disabledReason: "auth_permanent",
      },
    },
  })),
  resolveAuthProfileEligibility: vi.fn(() => ({ eligible: true })),
  resolveAuthProfileOrder: vi.fn(() => ["fixture-provider:stale"]),
  maybeReprobeWhamBlockedProfiles: vi.fn(() => undefined),
}));

vi.mock("./auth-profiles.runtime.js", () => authRuntime);
vi.mock("./auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSource: () => true,
}));
vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));
vi.mock("../plugins/providers.js", () => ({
  resolveProviderRefOwnership: () => ({ status: "unowned" }),
}));
vi.mock("../plugins/provider-model-routes.js", () => ({
  resolveProviderModelCatalogId: () => null,
  resolveProviderModelPolicySurface: () => null,
  resolveProviderModelRoutes: () => null,
}));

afterEach(() => {
  clearAgentHarnesses();
  vi.clearAllMocks();
});

describe("host-owned model fallback authentication", () => {
  it.each([
    { runtime: "auto", supported: true, expectedOwner: "host" },
    { runtime: "fixture-host", supported: false, expectedOwner: undefined },
  ] as const)(
    "uses the selected owner for $runtime with supported=$supported",
    async ({ runtime, supported, expectedOwner }) => {
      registerAgentHarness(
        {
          id: "fixture-host",
          label: "Fixture host",
          supports: () =>
            supported ? { supported: true } : { supported: false, fallbackRuntime: "openclaw" },
          resolveAuthOwnership: () => "host",
          runAttempt: async () => {
            throw new Error("Ownership selection does not execute a turn");
          },
        },
        { ownerPluginId: "fixture-host-plugin" },
      );
      const result = await resolveModelFallbackCandidateHarnessAuthPrecheck({
        cfg: createModelFallbackConfig("fixture-provider/fixture-model", []),
        provider: "fixture-provider",
        model: "fixture-model",
        resolveAgentHarnessRuntimeOverride: () => runtime,
      });
      expect(result.authOwner).toBe(expectedOwner);
    },
  );

  it.each([
    "resolveAuthProfileEligibility",
    "resolveAuthProfileOrder",
    "maybeReprobeWhamBlockedProfiles",
  ] as const)(
    "runs with host auth when gateway %s would reject stale credentials",
    async (phase) => {
      authRuntime[phase].mockImplementationOnce(() => {
        throw new Error(`Gateway ${phase} rejected the stale profile`);
      });
      registerAgentHarness(
        {
          id: "fixture-host",
          label: "Fixture host",
          supports: () => ({ supported: true }),
          resolveAuthOwnership: () => "host",
          runAttempt: async () => {
            throw new Error("The fallback callback owns the fixture execution");
          },
        },
        { ownerPluginId: "fixture-host-plugin" },
      );
      const run = vi.fn().mockResolvedValue("host authenticated");

      const result = await runWithModelFallback({
        cfg: createModelFallbackConfig("fixture-provider/fixture-model", []),
        provider: "fixture-provider",
        model: "fixture-model",
        userLockedAuthProfileId: "fixture-provider:stale",
        manifestPlugins: [],
        resolveAgentHarnessRuntimeOverride: () => "fixture-host",
        run,
      });

      expect(result.result).toBe("host authenticated");
      expect(run.mock.calls).toMatchObject([
        ["fixture-provider", "fixture-model", { isFinalFallbackAttempt: true }],
      ]);
    },
  );
});
