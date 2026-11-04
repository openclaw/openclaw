import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { resolveAuthProfileOrder } from "./auth-profiles/order.js";
import { hasAnyAuthProfileStoreSourceAsync } from "./auth-profiles/source-check.js";
import { ensureAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
} from "./auth-profiles/usage.js";
import { FailoverError } from "./failover-error.js";
import type { ModelFallbackRunFn } from "./model-fallback-attempt.js";
import {
  markProbeAttempt,
  resolveCooldownDecision,
  resolveProbeThrottleKey,
} from "./model-fallback-cooldown.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { createSessionPlacementSettlementClosedAbortError } from "./run-termination.js";
import type { SessionSuspensionParams } from "./session-suspension.js";
import {
  makeModelFallbackCfg as makeCfg,
  createModelFallbackConfig,
} from "./test-helpers/model-fallback-config-fixture.js";

// mock-isolation: Cooldown probes use fixture profile state without loading or updating host stores.
vi.mock("./auth-profiles/store-runtime.js", () => ({
  ensureAuthProfileStore: vi.fn(),
  ensureAuthProfileStoreAsync: (...args: Parameters<typeof ensureAuthProfileStore>) =>
    ensureAuthProfileStore(...args),
  loadAuthProfileStoreForRuntimeAsync: vi.fn(),
}));
vi.mock("./auth-profiles/usage.js", () => ({
  getSoonestCooldownExpiry: vi.fn(),
  isProfileInCooldown: vi.fn(),
  maybeReprobeWhamBlockedProfiles: vi.fn(),
  resolveProfilesUnavailableReason: vi.fn(),
}));
vi.mock("./auth-profiles/order.js", () => ({ resolveAuthProfileOrder: vi.fn() }));
vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));
// mock-isolation: Cooldown probing uses the mocked profile store; disk source discovery must stay isolated.
vi.mock("./auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSourceAsync: vi.fn(() => true),
}));
const deferredSuspension = vi.hoisted(
  () =>
    ({
      cfg: {},
      sessionId: "test-session",
      reason: "quota_exhausted",
      failedProvider: "openai",
      failedModel: "gpt-4.1-mini",
    }) satisfies SessionSuspensionParams,
);
const sessionSuspensionMocks = vi.hoisted(() => ({
  suspendSession: vi.fn().mockResolvedValue(undefined),
  runWithDeferredSessionSuspension: vi.fn(
    (run: () => Promise<unknown>, onDeferred?: (params: SessionSuspensionParams) => void) => {
      onDeferred?.(deferredSuspension);
      return run();
    },
  ),
  resolveSessionSuspensionReason: vi.fn((reason: string) =>
    reason === "billing" ? "manual" : reason === "rate_limit" ? "quota_exhausted" : "circuit_open",
  ),
}));
vi.mock("./session-suspension.js", () => sessionSuspensionMocks);
vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => {
  const { createEmptyPluginMetadataSnapshot } =
    await import("../plugins/plugin-metadata-empty.test-support.js");
  const snapshot = {
    ...createEmptyPluginMetadataSnapshot(),
    policyHash: "model-fallback-probe-test-empty-plugin-policy",
    configFingerprint: "model-fallback-probe-test-empty-plugin-metadata",
  };
  snapshot.index.policyHash = snapshot.policyHash;
  snapshot.index.generatedAtMs = 0;
  return {
    ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
    getCurrentPluginMetadataSnapshot: () => snapshot,
  };
});

const NOW = 1_700_000_000_000;
const candidate = { provider: "openai", model: "gpt-4.1-mini" };
const backup = ["anthropic", "claude-haiku-3-5"] as const;
const getExpiry = vi.mocked(getSoonestCooldownExpiry);
const unavailableReason = vi.mocked(resolveProfilesUnavailableReason);
const inCooldown = vi.mocked(isProfileInCooldown);
const profileOrder = vi.mocked(resolveAuthProfileOrder);
const expectedProbe = { type: "attempt", reason: "rate_limit", markProbe: true };
const suspended = { type: "suspend_session", reason: "rate_limit" };
let agentDir: string;
function runPrimary<T>(
  run: ModelFallbackRunFn<T>,
  overrides: Partial<Omit<Parameters<typeof runWithModelFallback<T>>[0], "run">> = {},
) {
  return runWithModelFallback({ cfg: makeCfg(), ...candidate, agentDir, run, ...overrides });
}
function expectSuspendedProvider(failedProvider: string) {
  expect(sessionSuspensionMocks.suspendSession).toHaveBeenCalledWith(
    expect.objectContaining({ failedProvider }),
  );
  expect(sessionSuspensionMocks.suspendSession.mock.calls.at(-1)?.[0]).not.toHaveProperty("laneId");
}
function cooldownDecision(params: {
  soonest: number;
  hasFallbackCandidates?: boolean;
  throttleKey?: string;
  usageStats?: AuthProfileStore["usageStats"];
}) {
  getExpiry.mockReturnValue(params.soonest);
  unavailableReason.mockReturnValue("rate_limit");
  return resolveCooldownDecision({
    candidate,
    isPrimary: true,
    requestedModel: true,
    hasFallbackCandidates: params.hasFallbackCandidates ?? true,
    now: NOW,
    probeThrottleKey: params.throttleKey ?? resolveProbeThrottleKey(candidate.provider, agentDir),
    authRuntime: {
      getSoonestCooldownExpiry: getExpiry,
      resolveProfilesUnavailableReason: unavailableReason,
    },
    authStore: { version: 1, profiles: {}, usageStats: params.usageStats },
    profileIds: ["openai-profile-1"],
  });
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  setLoggerOverride({ level: "silent", consoleLevel: "silent" });
  agentDir = path.join(os.tmpdir(), `model-fallback-probe-${randomUUID()}`);
  vi.mocked(hasAnyAuthProfileStoreSourceAsync).mockResolvedValue(true);
  vi.mocked(ensureAuthProfileStore).mockReturnValue({ version: 1, profiles: {} });
  profileOrder.mockImplementation(({ provider }) =>
    ["openai", "anthropic", "google"].includes(provider) ? [`${provider}-profile-1`] : [],
  );
  inCooldown.mockImplementation((_store, profileId) => profileId.startsWith("openai"));
  unavailableReason.mockReturnValue("rate_limit");
});
afterEach(() => {
  setLoggerOverride(null);
  resetLogger();
  sessionSuspensionMocks.suspendSession.mockClear();
  sessionSuspensionMocks.runWithDeferredSessionSuspension.mockClear();
  vi.restoreAllMocks();
});

describe("runWithModelFallback probe logic", () => {
  it("distinguishes a local skip from its retained timeout failure", async () => {
    getExpiry.mockReturnValue(NOW + 30 * 60 * 1000);
    unavailableReason.mockReturnValue("timeout");
    markProbeAttempt(NOW - 10_000, resolveProbeThrottleKey(candidate.provider, agentDir));
    const run = vi.fn().mockResolvedValue("ok");
    const result = await runPrimary(run);
    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledExactlyOnceWith(...backup, expect.any(Object));
    expect(result.attempts[0]).toMatchObject({ reason: "timeout", code: "MODEL_FALLBACK_SKIPPED" });
  });

  it("re-probes a single-provider primary blocked by a far-future subscription_limit (#90702)", () => {
    const soonest = NOW + 6 * 24 * 60 * 60 * 1000;
    const params: Parameters<typeof cooldownDecision>[0] = {
      soonest,
      hasFallbackCandidates: false,
      usageStats: {
        "openai-profile-1": {
          blockedUntil: soonest,
          blockedReason: "subscription_limit",
          blockedSource: "wham",
        },
      },
    };
    expect(cooldownDecision(params)).toEqual(expectedProbe);
    markProbeAttempt(NOW - 10_000, resolveProbeThrottleKey(candidate.provider, agentDir));
    expect(cooldownDecision(params)).toEqual(suspended);
  });

  it("honors provider rate-limit windows until they are near expiry", () => {
    const params = { soonest: NOW + 30 * 60 * 1000 };
    expect(cooldownDecision(params)).toEqual(suspended);
    expect(cooldownDecision({ ...params, soonest: NOW + 60 * 1000 })).toEqual(expectedProbe);
  });

  it("returns a successful primary cooldown probe without trying a fallback", async () => {
    getExpiry.mockReturnValue(NOW + 60 * 1000);
    const run = vi.fn().mockResolvedValue("probed-ok");
    const onFallbackStep = vi.fn();
    const result = await runPrimary(run, { onFallbackStep });
    expect(result.result).toBe("probed-ok");
    expect(run).toHaveBeenCalledExactlyOnceWith(
      candidate.provider,
      candidate.model,
      expect.objectContaining({ allowTransientCooldownProbe: true }),
    );
    expect(onFallbackStep).not.toHaveBeenCalled();
  });

  it("attempts non-primary fallbacks during overloaded cooldown after primary probe failure", async () => {
    inCooldown.mockReturnValue(true);
    getExpiry.mockReturnValue(NOW + 30 * 1000);
    unavailableReason.mockReturnValue("overloaded");
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("service overloaded"), { status: 503 }))
      .mockResolvedValue("fallback-ok");
    const result = await runPrimary(run, {
      cfg: createModelFallbackConfig("openai/gpt-4.1-mini", [
        "anthropic/claude-haiku-3-5",
        "google/gemini-2-flash",
      ]),
    });
    expect(result.result).toBe("fallback-ok");
    expect(run.mock.calls).toMatchObject([
      ["openai", "gpt-4.1-mini", { allowTransientCooldownProbe: true }],
      [...backup, { allowTransientCooldownProbe: true }],
    ]);
  });

  it("keeps walking remaining fallbacks after an abort-wrapped RESOURCE_EXHAUSTED probe failure", async () => {
    const requested = { provider: "google", model: "gemini-3-flash-preview" };
    profileOrder.mockImplementation(({ provider }) =>
      ["google", "anthropic", "deepseek"].includes(provider) ? [`${provider}-profile-1`] : [],
    );
    inCooldown.mockImplementation((_store, profileId) => profileId.startsWith("google"));
    getExpiry.mockReturnValue(NOW + 30 * 1000);
    const primaryAbort = Object.assign(new Error("request aborted"), {
      name: "AbortError",
      cause: {
        error: {
          code: 429,
          message: "Resource has been exhausted (e.g. check quota).",
          status: "RESOURCE_EXHAUSTED",
        },
      },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(primaryAbort)
      .mockRejectedValueOnce(
        Object.assign(new Error("fallback still rate limited"), { status: 429 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("final fallback still rate limited"), { status: 429 }),
      );
    await expect(
      runPrimary(run, {
        ...requested,
        cfg: createModelFallbackConfig("google/gemini-3-flash-preview", [
          "anthropic/claude-haiku-3-5",
          "deepseek/deepseek-chat",
        ]),
      }),
    ).rejects.toThrow(/All models failed \(3\)/);
    expect(
      run.mock.calls.map(([provider, model, options]) => [
        provider,
        model,
        options.allowTransientCooldownProbe,
      ]),
    ).toEqual([
      ["google", "gemini-3-flash-preview", true],
      [...backup, undefined],
      ["deepseek", "deepseek-chat", undefined],
    ]);
  });

  it("caps probe throttle state by evicting the oldest entries", () => {
    const keys = Array.from({ length: 256 }, (_, i) =>
      resolveProbeThrottleKey(`key-${i}`, agentDir),
    );
    for (const [i, key] of keys.entries()) {
      markProbeAttempt(NOW - 1_000 + i, key);
    }
    const refreshed = resolveProbeThrottleKey("key-0", agentDir);
    const freshest = resolveProbeThrottleKey("freshest", agentDir);
    markProbeAttempt(NOW - 1, refreshed);
    markProbeAttempt(NOW, freshest);
    const decision = (throttleKey: string) =>
      cooldownDecision({ soonest: NOW + 30_000, throttleKey });
    expect(
      [...keys, freshest].filter((key) => decision(key).type === "suspend_session"),
    ).toHaveLength(256);
    expect(decision(freshest).type).toBe("suspend_session");
    expect(decision(resolveProbeThrottleKey("key-1", agentDir))).toEqual(expectedProbe);
    expect(decision(refreshed).type).toBe("suspend_session");
  });

  it("scopes probe throttling by agentDir to avoid cross-agent suppression", () => {
    const agentAKey = resolveProbeThrottleKey("openai", path.join(agentDir, "agent-a"));
    const agentBKey = resolveProbeThrottleKey("openai", path.join(agentDir, "agent-b"));
    markProbeAttempt(NOW - 10_000, agentAKey);
    const params = { soonest: NOW + 30 * 1000 };
    expect(cooldownDecision({ ...params, throttleKey: agentAKey })).toEqual(suspended);
    expect(cooldownDecision({ ...params, throttleKey: agentBKey })).toEqual(expectedProbe);
  });

  it("does not suspend the session when fallback candidates remain", async () => {
    getExpiry.mockReturnValue(NOW + 30 * 60 * 1000);
    unavailableReason.mockReturnValue("billing");
    const run = vi.fn().mockResolvedValue("ok");
    const result = await runPrimary(run, { sessionId: "test-session", lane: "main" });
    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledExactlyOnceWith(...backup, expect.any(Object));
    expect(result.attempts[0]?.reason).toBe("billing");
    expect(sessionSuspensionMocks.suspendSession).not.toHaveBeenCalled();
  });

  it.each(["caller abort", "terminal classified result", "closed throw"])(
    "settles deferred suspension for %s",
    async (mode) => {
      inCooldown.mockReturnValue(false);
      const controller = new AbortController();
      const disconnect = Object.assign(new Error("client disconnected"), {
        name: "ClientDisconnectError",
      });
      const error =
        mode === "caller abort"
          ? disconnect
          : new AggregateError(
              [
                mode === "closed throw"
                  ? createSessionPlacementSettlementClosedAbortError()
                  : new FailoverError("recorded terminal stop", {
                      reason: "unknown",
                      code: "cli_max_turns",
                    }),
              ],
              "wrapper",
            );
      const run = vi.fn(async () => {
        if (mode === "caller abort") {
          controller.abort(disconnect);
        }
        if (mode === "terminal classified result") {
          return "partial result";
        }
        throw error;
      });
      await expect(
        runPrimary(run, {
          classifyResult: () => ({ error }),
          sessionId: "test-session",
          lane: "main",
          abortSignal: controller.signal,
        }),
      ).rejects.toBe(error);
      expect(run).toHaveBeenCalledOnce();
      expect(sessionSuspensionMocks.runWithDeferredSessionSuspension).toHaveBeenCalledOnce();
      if (mode === "terminal classified result") {
        expect(sessionSuspensionMocks.suspendSession).toHaveBeenCalledExactlyOnceWith(
          deferredSuspension,
        );
      } else {
        expect(sessionSuspensionMocks.suspendSession).not.toHaveBeenCalled();
      }
    },
  );

  it("records the final candidate when later candidates cannot run", async () => {
    inCooldown.mockImplementation((_store, profileId) => profileId.startsWith("anthropic"));
    getExpiry.mockReturnValue(NOW + 30 * 60 * 1000);
    unavailableReason.mockReturnValue("billing");
    profileOrder.mockImplementation(({ provider }) => [`${provider}-profile-1`]);
    const run = vi.fn().mockRejectedValueOnce(new Error("primary failed"));
    await expect(runPrimary(run, { sessionId: "test-session" })).rejects.toThrow();
    expect(run).toHaveBeenCalledOnce();
    expectSuspendedProvider("anthropic");
  });

  it("restores deferred suspension when a later harness precheck fails", async () => {
    inCooldown.mockReturnValue(false);
    const run = vi.fn().mockRejectedValueOnce(new Error("primary failed"));
    await expect(
      runPrimary(run, {
        sessionId: "test-session",
        resolveAgentHarnessRuntimeOverride: (provider) =>
          provider === "anthropic" ? "missing-strict-harness" : undefined,
        prepareAgentHarnessRuntime: () => undefined,
      }),
    ).rejects.toThrow('Requested agent harness "missing-strict-harness" is not registered.');
    expect(run).toHaveBeenCalledOnce();
    expectSuspendedProvider("openai");
  });
});
