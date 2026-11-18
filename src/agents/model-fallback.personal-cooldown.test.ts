import crypto from "node:crypto";
import { vi, describe, expect, it } from "vitest";
import {
  connectUserModelAccount,
  updateUserModelAuthProfile,
} from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { ensureAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { FailoverError } from "./failover-error.js";
import { isFallbackSummaryError } from "./model-fallback-attempt.js";
import {
  markProbeAttempt,
  resolveCooldownDecision,
  resolveProbeThrottleKey,
} from "./model-fallback-cooldown.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import * as sessionSuspension from "./session-suspension.js";
import { createModelFallbackConfig } from "./test-helpers/model-fallback-config-fixture.js";

describe("personal account fallback cooldown summaries", () => {
  it("refreshes selected cooldown with authored order", async () => {
    await withOpenClawTestState(
      { layout: "home", prefix: "fallback-personal-expiry-" },
      async (state) => {
        const person = ensureProfileForEmail("alice@example.test");
        const { authProfileId } = connectUserModelAccount({
          ownerProfileId: person.id,
          credential: { type: "api_key", provider: "personal-provider", key: "synthetic-key" },
          assertCurrent() {},
        });
        const expiry = Date.now() + 120_000;
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "personal-provider:shared": {
              type: "api_key",
              provider: "personal-provider",
              key: "synthetic-shared-key",
            },
          },
          usageStats: {
            "personal-provider:shared": {
              cooldownUntil: expiry + 600_000,
              cooldownReason: "rate_limit",
            },
          },
        });
        const attempted: string[] = [];
        let failure: unknown;
        try {
          await runWithModelFallback({
            cfg: {
              plugins: { enabled: false },
              auth: { order: { "personal-provider": ["personal-provider:shared"] } },
            },
            agentDir: state.agentDir(),
            provider: "personal-provider",
            model: "test-model",
            fallbacksOverride: ["backup-provider/test-model"],
            userLockedAuthProfileId: authProfileId,
            manifestPlugins: [],
            run: async (provider) => {
              attempted.push(provider);
              if (provider === "personal-provider") {
                updateUserModelAuthProfile(authProfileId, (account) => {
                  account.usageStats = {
                    cooldownUntil: expiry,
                    cooldownReason: "rate_limit",
                    cooldownModel: "test-model",
                  };
                  return true;
                });
              }
              throw Object.assign(new Error("synthetic rate limit"), { status: 429 });
            },
          });
        } catch (error) {
          failure = error;
        }
        expect(attempted).toEqual(["personal-provider", "backup-provider"]);
        expect(isFallbackSummaryError(failure)).toBe(true);
        if (!isFallbackSummaryError(failure)) {
          throw failure;
        }
        expect(failure.soonestCooldownExpiry).toBe(expiry);
        expect(ensureAuthProfileStore(state.agentDir()).profiles).not.toHaveProperty(authProfileId);
      },
    );
  });
});

describe("fallback probe and deferred suspension guards", () => {
  const deferred = {
    cfg: {},
    sessionId: "test-session",
    reason: "quota_exhausted" as const,
    failedProvider: "openai",
    failedModel: "gpt-4.1-mini",
  };
  const defaults = {
    cfg: {
      plugins: { enabled: false },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-4.1-mini", fallbacks: ["anthropic/claude-haiku-3-5"] },
        },
      },
    },
    provider: "openai",
    model: "gpt-4.1-mini",
    manifestPlugins: [],
    skipAuthProfileRuntime: true,
  };
  const runProbe = (
    params: Omit<Parameters<typeof runWithModelFallback>[0], "provider" | "model" | "cfg"> &
      Partial<Pick<Parameters<typeof runWithModelFallback>[0], "cfg">>,
  ) => runWithModelFallback({ ...defaults, ...params });
  async function withSuspension(action: (suspend: ReturnType<typeof vi.spyOn>) => Promise<void>) {
    using suspend = vi.spyOn(sessionSuspension, "suspendSession").mockResolvedValue(undefined);
    using _ = vi
      .spyOn(sessionSuspension, "runWithDeferredSessionSuspension")
      .mockImplementation((run, onDeferred) => {
        onDeferred?.(deferred);
        return run();
      });
    await action(suspend);
  }
  it("re-probes a single-provider primary blocked by a far-future subscription_limit (#90702)", () => {
    const now = 1700000000000,
      soonest = now + 6 * 24 * 60 * 60 * 1000,
      throttleKey = resolveProbeThrottleKey("openai", `probe-${crypto.randomUUID()}`);
    const decision = () =>
      resolveCooldownDecision({
        candidate: { provider: "openai", model: "gpt-4.1-mini" },
        isPrimary: true,
        requestedModel: true,
        hasFallbackCandidates: false,
        now,
        probeThrottleKey: throttleKey,
        authRuntime: {
          getSoonestCooldownExpiry: () => soonest,
          resolveProfilesUnavailableReason: () => "rate_limit",
        },
        authStore: {
          version: 1,
          profiles: {},
          usageStats: {
            "openai-profile-1": {
              blockedUntil: soonest,
              blockedReason: "subscription_limit",
              blockedSource: "wham",
            },
          },
        },
        profileIds: ["openai-profile-1"],
      });
    expect(decision()).toEqual({ type: "attempt", reason: "rate_limit", markProbe: true });
    markProbeAttempt(now - 10000, throttleKey);
    expect(decision()).toEqual({ type: "suspend_session", reason: "rate_limit" });
  });
  it.each(["caller abort", "terminal classified result"])(
    "settles deferred suspension for %s",
    async (mode) => {
      await withSuspension(async (suspend) => {
        const controller = new AbortController(),
          error =
            mode === "caller abort"
              ? Object.assign(new Error("client disconnected"), { name: "ClientDisconnectError" })
              : new AggregateError(
                  [
                    new FailoverError("recorded terminal stop", {
                      reason: "unknown",
                      code: "cli_max_turns",
                    }),
                  ],
                  "wrapper",
                );
        const run = vi.fn(async () => {
          if (mode === "caller abort") {
            controller.abort(error);
            throw error;
          }
          return "partial result";
        });
        await expect(
          runProbe({
            run,
            classifyResult: () => ({ error }),
            sessionId: "test-session",
            lane: "main",
            abortSignal: controller.signal,
          }),
        ).rejects.toBe(error);
        expect(run).toHaveBeenCalledOnce();
        if (mode === "terminal classified result") {
          expect(suspend).toHaveBeenCalledExactlyOnceWith(deferred);
        } else {
          expect(suspend).not.toHaveBeenCalled();
        }
      });
    },
  );
  it("restores deferred suspension when a later harness precheck fails", async () => {
    await withOpenClawTestState({ label: "fallback-precheck" }, async (state) => {
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          "openai:probe": { type: "api_key", provider: "openai", key: "fixture-openai-key" },
          "anthropic:probe": {
            type: "api_key",
            provider: "anthropic",
            key: "fixture-anthropic-key",
          },
        },
      });
      await withSuspension(async (suspend) => {
        const run = vi.fn().mockRejectedValueOnce(new Error("primary failed"));
        await expect(
          runProbe({
            cfg: {
              ...createModelFallbackConfig("openai/gpt-4.1-mini", ["anthropic/claude-haiku-3-5"]),
              plugins: { enabled: false },
            },
            agentDir: state.agentDir(),
            skipAuthProfileRuntime: false,
            run,
            sessionId: "test-session",
            resolveAgentHarnessRuntimeOverride: (provider) =>
              provider === "anthropic" ? "missing-strict-harness" : undefined,
            prepareAgentHarnessRuntime: () => undefined,
          }),
        ).rejects.toThrow('Requested agent harness "missing-strict-harness" is not registered.');
        expect(run).toHaveBeenCalledOnce();
        expect(suspend).toHaveBeenCalledWith(expect.objectContaining({ failedProvider: "openai" }));
      });
    });
  });
});
