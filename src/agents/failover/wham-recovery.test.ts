import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { AuthProfileStore, ProfileUsageStats } from "../auth-profiles/types.js";
import { isProfileInCooldown } from "../auth-profiles/usage-state.js";
import { testing as usageTesting } from "../auth-profiles/usage.test-support.js";
import { FailoverError } from "../failover-error.js";
import { clearAgentHarnesses, registerAgentHarness } from "../harness/registry.js";
import { runWithModelFallback } from "../model-fallback-runner.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  ensureStore: vi.fn<() => AuthProfileStore>(),
  loadStore: vi.fn<() => AuthProfileStore>(),
  order: vi.fn(() => ["openai:primary"]),
  eligibility: vi.fn(() => ({ eligible: true })),
  cooldown: vi.fn(() => true),
  updateStore:
    vi.fn<typeof import("../auth-profiles/store-runtime.js").updateAuthProfileStoreWithLock>(),
  resolveOwner: vi.fn((params: { agentDir?: string }) => params.agentDir),
}));

// Keep store ownership and HTTP at test boundaries; execute the actual WHAM
// claim, response classification, and compare-and-swap recovery code.
vi.mock("../auth-profiles/store.js", () => ({
  resolvePersistedAuthProfileOwnerAgentDir: mocks.resolveOwner,
}));
vi.mock("../auth-profiles/store-runtime.js", () => ({
  updateAuthProfileStoreWithLock: mocks.updateStore,
}));
vi.mock("../auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSource: () => true,
}));
vi.mock("../auth-profiles.runtime.js", async () => {
  const usage = await import("../auth-profiles/usage.js");
  return {
    ensureAuthProfileStore: mocks.ensureStore,
    loadAuthProfileStoreForRuntime: mocks.loadStore,
    resolveAuthProfileOrder: mocks.order,
    resolveAuthProfileEligibility: mocks.eligibility,
    isProfileInCooldown: mocks.cooldown,
    getSoonestCooldownExpiry: usage.getSoonestCooldownExpiry,
    resolveProfilesUnavailableReason: usage.resolveProfilesUnavailableReason,
    maybeReprobeWhamBlockedProfiles: usage.maybeReprobeWhamBlockedProfiles,
  };
});
vi.mock("../provider-request-config.js", () => ({
  resolveProviderRequestHeaders: (params: { defaultHeaders: Record<string, string> }) =>
    params.defaultHeaders,
}));
vi.mock("../provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));
vi.mock("../../plugins/providers.runtime.js", () => ({
  isPluginProvidersLoadInFlight: () => false,
}));
vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: () => undefined,
  resolveLoadedProviderRuntimePlugin: () => undefined,
  resolveProviderPluginsForHooks: () => [],
  resolveLoadedProviderPluginsForHooks: () => [],
}));
vi.mock("../../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
}));
vi.mock("../session-suspension.js", () => ({
  suspendSession: vi.fn(),
  resolveSessionSuspensionReason: () => "quota_exhausted",
  runWithDeferredSessionSuspension: (run: () => Promise<unknown>) => run(),
}));

const NOW = 1_700_000_000_000;
const REPROBE_INTERVAL = 45 * 60 * 1000;
const PROFILE_ID = "openai:primary";
const BLOCKED_UNTIL = NOW + 6 * 24 * 60 * 60 * 1000;
const cfg: OpenClawConfig = {
  agents: { defaults: { model: { primary: "openai/gpt-5.5", fallbacks: [] } } },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        agentRuntime: { id: "codex" },
        models: [],
      },
    },
  },
};
let persisted: AuthProfileStore;
let store: AuthProfileStore;
const pendingResponses: Array<(response: Response) => void> = [];

function setStats(overrides: Partial<ProfileUsageStats> = {}): void {
  persisted.usageStats = {
    [PROFILE_ID]: {
      blockedUntil: BLOCKED_UNTIL,
      blockedReason: "subscription_limit",
      blockedSource: "wham",
      blockedModel: "gpt-5.5",
      blockedScope: "model",
      lastFailureAt: NOW - REPROBE_INTERVAL,
      lastProbeAt: NOW - REPROBE_INTERVAL,
      ...overrides,
    },
  };
  store = structuredClone(persisted);
}

function deferredWhamResponse() {
  const response = createDeferredCore<Response>();
  mocks.fetch.mockReturnValueOnce(response.promise);
  pendingResponses.push(response.resolve);
  return response.resolve;
}

function runNativeAttempt() {
  const run = vi.fn(async () => {
    if (isProfileInCooldown(persisted, PROFILE_ID, undefined, "gpt-5.5")) {
      throw new FailoverError("Native harness profile is blocked", {
        provider: "openai",
        model: "gpt-5.5",
        reason: "rate_limit",
      });
    }
    return "native response";
  });
  return {
    run,
    result: runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-5.5",
      manifestPlugins: [],
      run,
    }),
  };
}

async function expectNativeBlocked(): Promise<void> {
  const attempt = runNativeAttempt();
  await expect(attempt.result).rejects.toThrow("Native harness profile is blocked");
  expect(attempt.run).toHaveBeenCalledOnce();
  expect(mocks.cooldown).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
  persisted = {
    version: 1,
    profiles: {
      [PROFILE_ID]: {
        type: "oauth",
        provider: "openai",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: NOW + 24 * 60 * 60 * 1000,
      },
    },
  };
  setStats();
  mocks.ensureStore.mockImplementation(() => store);
  mocks.loadStore.mockImplementation(() => structuredClone(persisted));
  mocks.order.mockImplementation(() => [PROFILE_ID]);
  mocks.updateStore.mockImplementation(async ({ updater }) => {
    const fresh = structuredClone(persisted);
    if (updater(fresh)) {
      persisted = fresh;
    }
    return structuredClone(persisted);
  });
  usageTesting.setDepsForTest({ updateAuthProfileStoreWithLock: mocks.updateStore });
  clearAgentHarnesses();
  registerAgentHarness(
    {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("The supplied run callback owns the native attempt in this test");
      },
    },
    { ownerPluginId: "codex" },
  );
});

afterEach(async () => {
  for (const resolve of pendingResponses.splice(0)) {
    resolve(new Response("{}", { status: 503 }));
  }
  // Drain the background response continuation before resetting its dependency seam.
  await setImmediate();
  usageTesting.setDepsForTest(null);
  usageTesting.resetWhamReprobeStateForTest();
  clearAgentHarnesses();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("registered Codex harness WHAM recovery through model fallback", () => {
  it.each([
    ["account-wide", { blockedModel: undefined, blockedScope: undefined }],
    ["model-scoped", { blockedModel: "gpt-5.5", blockedScope: "model" }],
  ] satisfies [string, Partial<ProfileUsageStats>][])(
    "admits native attempts while background recovery of the %s WHAM block enables the next run",
    async (_scope, stats) => {
      setStats(stats);
      const release = deferredWhamResponse();
      await expectNativeBlocked();
      await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
      expect(persisted.usageStats?.[PROFILE_ID]?.blockedUntil).toBe(BLOCKED_UNTIL);

      // A second turn while the HTTP response is pending cannot start another probe.
      await expectNativeBlocked();
      expect(mocks.fetch).toHaveBeenCalledOnce();
      release(Response.json({ rate_limit: { limit_reached: false } }));
      await vi.waitFor(() => {
        expect(persisted.usageStats?.[PROFILE_ID]?.blockedUntil).toBeUndefined();
        expect(store.usageStats?.[PROFILE_ID]?.blockedUntil).toBeUndefined();
      });

      const next = runNativeAttempt();
      await expect(next.result).resolves.toMatchObject({
        outcome: "completed",
        result: "native response",
        provider: "openai",
        model: "gpt-5.5",
      });
      expect(next.run).toHaveBeenCalledOnce();
      expect(mocks.cooldown).not.toHaveBeenCalled();
      expect(mocks.fetch).toHaveBeenCalledOnce();
      expect(persisted.usageStats?.[PROFILE_ID]?.lastProbeAt).toBe(NOW);
    },
  );

  it.each([
    ["non-WHAM block", { blockedSource: "codex_rate_limits" }],
    ["recent probe", { lastProbeAt: NOW - REPROBE_INTERVAL + 1 }],
    ["soon-expiring block", { blockedUntil: NOW + REPROBE_INTERVAL }],
    ["active auth cooldown", { cooldownUntil: NOW + 60_000 }],
    ["disabled profile", { disabledUntil: NOW + 60_000 }],
  ] satisfies [string, Partial<ProfileUsageStats>][])(
    "preserves %s without starting WHAM recovery or generic admission checks",
    async (_label, stats) => {
      setStats(stats);
      await expectNativeBlocked();
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.updateStore).not.toHaveBeenCalled();
    },
  );

  it("allows native execution while preserving another model's WHAM block", async () => {
    setStats({ blockedModel: "gpt-4.1" });
    const next = runNativeAttempt();
    await expect(next.result).resolves.toMatchObject({
      outcome: "completed",
      result: "native response",
    });
    expect(next.run).toHaveBeenCalledOnce();
    expect(mocks.cooldown).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.updateStore).not.toHaveBeenCalled();
    expect(persisted.usageStats?.[PROFILE_ID]).toMatchObject({
      blockedModel: "gpt-4.1",
      blockedUntil: BLOCKED_UNTIL,
    });
  });

  it.each([
    ["HTTP failure", () => new Response("{}", { status: 503 })],
    ["unknown capacity", () => Response.json({})],
  ])("preserves the block after %s and throttles the next probe", async (_label, response) => {
    mocks.fetch.mockResolvedValueOnce(response());
    await expectNativeBlocked();
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    await setImmediate();
    await expectNativeBlocked();
    expect(persisted.usageStats?.[PROFILE_ID]?.blockedUntil).toBe(BLOCKED_UNTIL);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(persisted.usageStats?.[PROFILE_ID]?.lastProbeAt).toBe(NOW);
  });

  it("does not clear a newer WHAM block with an earlier available response", async () => {
    const release = deferredWhamResponse();
    await expectNativeBlocked();
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    const newerUntil = BLOCKED_UNTIL + 60_000;
    persisted.usageStats = {
      ...persisted.usageStats,
      [PROFILE_ID]: {
        ...persisted.usageStats?.[PROFILE_ID],
        blockedUntil: newerUntil,
        lastFailureAt: NOW + 1,
      },
    };
    release(Response.json({ rate_limit: { limit_reached: false } }));
    await vi.waitFor(() => expect(mocks.updateStore).toHaveBeenCalledTimes(2));
    expect(persisted.usageStats?.[PROFILE_ID]?.blockedUntil).toBe(newerUntil);
    await expectNativeBlocked();
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});
