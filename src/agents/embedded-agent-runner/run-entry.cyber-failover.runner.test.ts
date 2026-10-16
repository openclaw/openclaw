import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { isProfileInCooldown, markAuthProfileFailure } from "../auth-profiles/usage.js";
import { FailoverError } from "../failover-error.js";
import { resetFallbackSkipCacheForTest } from "../fallback-skip-cache.test-support.js";
import { runEmbeddedAgentEntry } from "./run-entry.js";
import { createDirectHarness } from "./run-entry.test-support.js";
import { resolveAuthProfileFailureReason } from "./run/auth-profile-failure-policy.js";
import type { AuthProfileFailurePolicy } from "./run/auth-profile-failure-policy.types.js";
import type { EmbeddedAgentRunResult } from "./types.js";

// Keep the real fallback runner: its committed-work veto must survive escalation's catch.
const authStoreRuntimeMocks = vi.hoisted(() => {
  const state: { store?: AuthProfileStore } = {};
  return {
    state,
    updateAuthProfileStoreWithLock: vi.fn(
      async (params: { updater: (store: AuthProfileStore) => boolean }) => {
        if (!state.store) {
          throw new Error("auth store fixture was not initialized");
        }
        const freshStore = structuredClone(state.store);
        params.updater(freshStore);
        state.store = freshStore;
        return freshStore;
      },
    ),
  };
});

vi.mock("../auth-profiles/store-runtime.js", () => ({
  updateAuthProfileStoreWithLock: authStoreRuntimeMocks.updateAuthProfileStoreWithLock,
}));
vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));
vi.mock("../harness/selection.js", () => ({
  selectAgentHarness: vi.fn(() => ({ id: "openclaw", contextEngineHostCapabilities: [] })),
}));

function makeResult(provider: string, model: string, refused = true): EmbeddedAgentRunResult {
  return {
    payloads: refused
      ? [{ text: "policy refusal", isError: true }]
      : [{ text: "primary model recovered" }],
    meta: {
      durationMs: 10,
      aborted: false,
      providerStarted: true,
      stopReason: "completed",
      agentMeta: {
        sessionId: "session-1",
        provider,
        model,
        agentHarnessId: "openclaw",
        ...(refused ? { providerRefusal: { provider: "openai", category: "cyber" } } : {}),
      },
    },
  };
}

type RunCandidate = Parameters<
  typeof runEmbeddedAgentEntry<EmbeddedAgentRunResult>
>[0]["runCandidate"];

function runEntry(runId: string, runCandidate: RunCandidate, hasCommittedSideEffect = () => false) {
  const config = {};
  setRuntimeConfigSnapshot(config);
  return runEmbeddedAgentEntry({
    selection: { cfg: config, provider: "openai", model: "gpt-5.6" },
    identity: { runId, agentId: "main", sessionId: "session-1" },
    harness: createDirectHarness(),
    behavior: { kind: "command-rpc", hasCommittedSideEffect },
    sessionOverride: { kind: "preserve" },
    runCandidate,
  });
}

describe("runEmbeddedAgentEntry cyber failover against the real fallback runner", () => {
  beforeEach(() => {
    resetFallbackSkipCacheForTest();
    authStoreRuntimeMocks.state.store = undefined;
    authStoreRuntimeMocks.updateAuthProfileStoreWithLock.mockClear();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it.each([false, true])(
    "accounts completed candidates with the real runner (exhausted: %s)",
    async (exhausted) => {
      setRuntimeConfigSnapshot({});
      const { result } = await runEmbeddedAgentEntry({
        selection: {
          cfg: {},
          provider: "openai",
          model: "gpt-5.6",
          fallbacksOverride: ["openai/gpt-5.6-mini"],
        },
        identity: {
          runId: "run-real-fallback-accounting",
          agentId: "main",
          sessionId: "session-1",
        },
        harness: createDirectHarness(),
        behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
        sessionOverride: { kind: "preserve" },
        runCandidate: async (provider, model) => {
          const primary = model === "gpt-5.6";
          const candidate = makeResult(provider, model, false);
          if (primary || exhausted) {
            candidate.payloads = [];
            candidate.meta.agentHarnessResultClassification = "empty";
          }
          if (exhausted) {
            candidate.meta.error = {
              kind: "incomplete_turn",
              message: "Completed candidate needs recovery",
              fallbackSafe: true,
            };
          }
          candidate.meta.agentMeta = {
            sessionId: "session-1",
            provider,
            model,
            usage: { input: primary ? 100 : 200, cost: { total: primary ? 0.2 : 0.7 } },
            lastCallUsage: { input: primary ? 90 : 20 },
          };
          return candidate;
        },
      });
      expect(result.meta.agentMeta?.usage?.input).toBe(300);
      expect(result.meta.agentMeta?.usage?.cost?.total).toBeCloseTo(0.9, 9);
      expect(result.meta.agentMeta?.lastCallUsage).toEqual({ input: 20 });
    },
  );

  it("retains completed policy-retry usage when restoring the original refusal", async () => {
    const { result } = await runEntry("run-cyber-restored-accounting", async (provider, model) => {
      const retry = model === "gpt-daybreak-blue-latest";
      const candidate = makeResult(provider, model, true);
      candidate.meta.agentMeta!.usage = {
        input: retry ? 200 : 100,
        cost: { total: retry ? 0.7 : 0.2 },
      };
      return candidate;
    });
    expect(result.meta.agentMeta).toMatchObject({
      model: "gpt-5.6",
      usage: { input: 300 },
    });
    expect(result.meta.agentMeta?.usage?.cost?.total).toBeCloseTo(0.9, 9);
    expect(result.payloads).toEqual([{ text: "policy refusal", isError: true }]);
  });

  it("propagates a recognized provider error thrown after the Daybreak retry delivered", async () => {
    const failure = new FailoverError("daybreak overloaded after delivering", {
      provider: "openai",
      model: "gpt-daybreak-blue-latest",
      reason: "overloaded",
    });
    let delivered = false;
    await expect(
      runEntry(
        "run-cyber-real-runner",
        async (provider, model) => {
          if (model === "gpt-daybreak-blue-latest") {
            delivered = true;
            throw failure;
          }
          return makeResult(provider, model);
        },
        () => delivered,
      ),
    ).rejects.toBe(failure);
    expect(delivered).toBe(true);
  });

  it("keeps primary auth usable after a denied Daybreak retry with default config", async () => {
    const authFailurePolicies: Array<string | undefined> = [];
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "sk-test" },
      },
    };
    authStoreRuntimeMocks.state.store = authStore;
    const profileId = "openai:default";
    const failure = new FailoverError("daybreak entitlement denied", {
      provider: "openai",
      model: "gpt-daybreak-blue-latest",
      reason: "auth",
    });
    let primaryAttempts = 0;
    const runCandidate = async (
      provider: string,
      model: string,
      options: { authProfileFailurePolicy?: AuthProfileFailurePolicy },
    ) => {
      authFailurePolicies.push(options.authProfileFailurePolicy);
      if (model === "gpt-daybreak-blue-latest") {
        const authFailureReason = resolveAuthProfileFailureReason({
          failoverReason: "auth",
          providerStarted: true,
          policy: options.authProfileFailurePolicy,
        });
        if (authFailureReason) {
          await markAuthProfileFailure({
            store: authStore,
            profileId,
            reason: authFailureReason,
            modelId: model,
          });
        }
        throw failure;
      }
      expect(isProfileInCooldown(authStore, profileId, undefined, model)).toBe(false);
      primaryAttempts += 1;
      return makeResult(provider, model, primaryAttempts === 1);
    };

    const refusedResult = await runEntry("run-cyber-real-runner-clean", runCandidate);
    expect(refusedResult.model).toBe("gpt-5.6");
    expect(refusedResult.result.payloads).toEqual([{ text: "policy refusal", isError: true }]);
    expect(authStore.usageStats?.[profileId]).toBeUndefined();
    expect(authStoreRuntimeMocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();

    const recoveredResult = await runEntry("run-cyber-real-runner-recovered", runCandidate);
    expect(recoveredResult.model).toBe("gpt-5.6");
    expect(recoveredResult.result.payloads).toEqual([{ text: "primary model recovered" }]);
    expect(authFailurePolicies).toEqual([undefined, "local", undefined]);
  });
});
