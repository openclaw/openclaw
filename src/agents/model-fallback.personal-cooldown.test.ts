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
import { AgentHarnessPreflightError } from "./harness/errors.js";
import { isFallbackSummaryError } from "./model-fallback-attempt.js";
import {
  markProbeAttempt,
  releaseProbeAttempt,
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
  it("only releases the cooldown probe reservation it owns", () => {
    const now = 1700000000000;
    const throttleKey = resolveProbeThrottleKey("openai", `probe-${crypto.randomUUID()}`);
    const decision = (at: number) =>
      resolveCooldownDecision({
        candidate: { provider: "openai", model: "gpt-4.1-mini" },
        isPrimary: true,
        requestedModel: true,
        hasFallbackCandidates: false,
        now: at,
        probeThrottleKey: throttleKey,
        authRuntime: {
          getSoonestCooldownExpiry: () => null,
          resolveProfilesUnavailableReason: () => "rate_limit",
        },
        authStore: { version: 1, profiles: {}, usageStats: {} },
        profileIds: ["openai-profile-1"],
      });
    const first = markProbeAttempt(now, throttleKey);
    const current = markProbeAttempt(now + 1, throttleKey);

    releaseProbeAttempt(first);
    expect(decision(now + 30_000)).toEqual({ type: "suspend_session", reason: "rate_limit" });

    releaseProbeAttempt(current);
    expect(decision(now + 30_000)).toEqual({
      type: "attempt",
      reason: "rate_limit",
      markProbe: true,
    });
  });
  it("lets a cooldowned primary retry after a local worker failure", async () => {
    await withOpenClawTestState({ label: "fallback-local-probe-failure" }, async (state) => {
      const profileId = "openai:recovery-probe";
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          [profileId]: { type: "api_key", provider: "openai", key: "synthetic-openai-key" },
        },
        usageStats: {
          [profileId]: {
            cooldownUntil: Date.now() + 120_000,
            cooldownReason: "rate_limit",
            cooldownModel: "gpt-4.1-mini",
          },
        },
      });
      const workerError = Object.assign(new Error("worker runner is unavailable"), {
        name: "WorkerRunnerUnavailableError",
        providerDispatchStarted: false,
      });
      const run = vi.fn(async () => {
        if (run.mock.calls.length === 1) {
          throw workerError;
        }
        return "primary recovered";
      });
      const invoke = () =>
        runWithModelFallback({
          cfg: {
            plugins: { enabled: false },
            auth: { order: { openai: [profileId] } },
            agents: { defaults: { model: { primary: "openai/gpt-4.1-mini", fallbacks: [] } } },
          },
          agentDir: state.agentDir(),
          provider: "openai",
          model: "gpt-4.1-mini",
          fallbacksOverride: [],
          manifestPlugins: [],
          skipAuthProfileRuntime: false,
          run,
        });

      await expect(invoke()).rejects.toMatchObject({ name: "WorkerRunnerUnavailableError" });
      expect(run).toHaveBeenCalledOnce();
      await expect(invoke()).resolves.toMatchObject({
        outcome: "completed",
        result: "primary recovered",
      });
      expect(run).toHaveBeenCalledTimes(2);
    });
  });
  it("releases a probe reservation returned by harness preflight", async () => {
    await withOpenClawTestState({ label: "fallback-preflight-probe-failure" }, async (state) => {
      const profileId = "openai:preflight-probe";
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          [profileId]: { type: "api_key", provider: "openai", key: "synthetic-openai-key" },
        },
        usageStats: {
          [profileId]: {
            cooldownUntil: Date.now() + 120_000,
            cooldownReason: "rate_limit",
            cooldownModel: "gpt-4.1-mini",
          },
        },
      });
      const preflightError = new AgentHarnessPreflightError("local harness preflight failed");
      const run = vi.fn(async () => "primary recovered").mockRejectedValueOnce(preflightError);
      const invoke = () =>
        runWithModelFallback({
          cfg: {
            plugins: { enabled: false },
            auth: { order: { openai: [profileId] } },
            agents: { defaults: { model: { primary: "openai/gpt-4.1-mini", fallbacks: [] } } },
          },
          agentDir: state.agentDir(),
          provider: "openai",
          model: "gpt-4.1-mini",
          fallbacksOverride: [],
          manifestPlugins: [],
          skipAuthProfileRuntime: false,
          run,
        });

      await expect(invoke()).rejects.toBe(preflightError);
      await expect(invoke()).resolves.toMatchObject({
        outcome: "completed",
        result: "primary recovered",
      });
      expect(run).toHaveBeenCalledTimes(2);
    });
  });
  it("does not release the probe after post-dispatch transcript coordination failure", async () => {
    await withOpenClawTestState({ label: "fallback-post-dispatch-coordination" }, async (state) => {
      const profileId = "openai:post-dispatch-probe";
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          [profileId]: { type: "api_key", provider: "openai", key: "synthetic-openai-key" },
        },
        usageStats: {
          [profileId]: {
            cooldownUntil: Date.now() + 120_000,
            cooldownReason: "rate_limit",
            cooldownModel: "gpt-4.1-mini",
          },
        },
      });
      const postDispatchError = Object.assign(
        new Error("transcript writer claim changed after the provider completed"),
        { name: "SessionTranscriptWriterClaimReboundError" },
      );
      const run = vi.fn(async () => {
        throw postDispatchError;
      });
      const invoke = () =>
        runWithModelFallback({
          cfg: {
            plugins: { enabled: false },
            auth: { order: { openai: [profileId] } },
            agents: { defaults: { model: { primary: "openai/gpt-4.1-mini", fallbacks: [] } } },
          },
          agentDir: state.agentDir(),
          provider: "openai",
          model: "gpt-4.1-mini",
          fallbacksOverride: [],
          manifestPlugins: [],
          skipAuthProfileRuntime: false,
          run,
        });

      await expect(invoke()).rejects.toBe(postDispatchError);
      await expect(invoke()).rejects.toThrow(/cooldown/);
      expect(run).toHaveBeenCalledOnce();
    });
  });
  it("reserves a probe before another turn can pass the cooldown decision", async () => {
    await withOpenClawTestState(
      { label: "fallback-concurrent-probe-reservation" },
      async (state) => {
        const profileId = "openai:concurrent-probe";
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            [profileId]: { type: "api_key", provider: "openai", key: "synthetic-openai-key" },
          },
          usageStats: {
            [profileId]: {
              cooldownUntil: Date.now() + 120_000,
              cooldownReason: "rate_limit",
              cooldownModel: "gpt-4.1-mini",
            },
          },
        });
        const run = vi.fn(async () => "primary probe completed");
        const invoke = () =>
          runWithModelFallback({
            cfg: {
              plugins: { enabled: false },
              auth: { order: { openai: [profileId] } },
              agents: { defaults: { model: { primary: "openai/gpt-4.1-mini", fallbacks: [] } } },
            },
            agentDir: state.agentDir(),
            provider: "openai",
            model: "gpt-4.1-mini",
            fallbacksOverride: [],
            manifestPlugins: [],
            skipAuthProfileRuntime: false,
            run,
          });

        const outcomes = await Promise.allSettled([invoke(), invoke()]);
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        expect(run).toHaveBeenCalledOnce();
      },
    );
  });
  it("keeps a cooldowned primary throttled after a provider failure", async () => {
    await withOpenClawTestState({ label: "fallback-provider-probe-failure" }, async (state) => {
      const profileId = "openai:provider-probe";
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          [profileId]: { type: "api_key", provider: "openai", key: "synthetic-openai-key" },
        },
        usageStats: {
          [profileId]: {
            cooldownUntil: Date.now() + 120_000,
            cooldownReason: "rate_limit",
            cooldownModel: "gpt-4.1-mini",
          },
        },
      });
      const run = vi.fn(async () => {
        throw new FailoverError("synthetic provider rate limit", {
          reason: "rate_limit",
          provider: "openai",
          model: "gpt-4.1-mini",
          status: 429,
        });
      });
      const invoke = () =>
        runWithModelFallback({
          cfg: {
            plugins: { enabled: false },
            auth: { order: { openai: [profileId] } },
            agents: { defaults: { model: { primary: "openai/gpt-4.1-mini", fallbacks: [] } } },
          },
          agentDir: state.agentDir(),
          provider: "openai",
          model: "gpt-4.1-mini",
          fallbacksOverride: [],
          manifestPlugins: [],
          skipAuthProfileRuntime: false,
          run,
        });

      await expect(invoke()).rejects.toThrow("synthetic provider rate limit");
      expect(run).toHaveBeenCalledOnce();
      await expect(invoke()).rejects.toThrow(/cooldown/);
      expect(run).toHaveBeenCalledOnce();
    });
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
