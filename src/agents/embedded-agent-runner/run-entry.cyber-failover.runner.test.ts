import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeConfig from "../../config/runtime-snapshot.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { isProfileInCooldown, markAuthProfileFailure } from "../auth-profiles/usage.js";
import { FailoverError } from "../failover-error.js";
import { resetFallbackSkipCacheForTest } from "../fallback-skip-cache.test-support.js";
import { runEmbeddedAgentEntry } from "./run-entry.js";
import { createDirectHarness, makeResult as makeBaseResult } from "./run-entry.test-support.js";
import { resolveAuthProfileFailureReason } from "./run/auth-profile-failure-policy.js";
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
  const result = makeBaseResult({ provider, model });
  result.payloads = refused
    ? [{ text: "policy refusal", isError: true }]
    : [{ text: "primary model recovered" }];
  Object.assign(result.meta.agentMeta!, {
    agentHarnessId: "openclaw",
    ...(refused ? { providerRefusal: { provider: "openai", category: "cyber" } } : {}),
  });
  return result;
}

type RunCandidate = Parameters<typeof runEmbeddedAgentEntry>[0]["runCandidate"];

function retryFailure(message: string, reason: "auth" | "overloaded") {
  return new FailoverError(message, {
    provider: "openai",
    model: "gpt-daybreak-blue-latest",
    reason,
  });
}

function runEntry(
  runId: string,
  runCandidate: RunCandidate,
  hasCommittedSideEffect = () => false,
  fallbacksOverride?: string[],
) {
  return runEmbeddedAgentEntry({
    selection: { cfg: {}, provider: "openai", model: "gpt-5.6", fallbacksOverride },
    identity: { runId, agentId: "main", sessionId: "session-1" },
    harness: createDirectHarness(),
    behavior: { kind: "command-rpc", hasCommittedSideEffect },
    sessionOverride: { kind: "preserve" },
    runCandidate,
  });
}

describe("runEmbeddedAgentEntry cyber failover against the real fallback runner", () => {
  beforeEach(() => {
    runtimeConfig.setRuntimeConfigSnapshot({});
    resetFallbackSkipCacheForTest();
    authStoreRuntimeMocks.state.store = undefined;
    authStoreRuntimeMocks.updateAuthProfileStoreWithLock.mockClear();
  });

  afterEach(runtimeConfig.clearRuntimeConfigSnapshot);

  it.each(["fallback success", "fallback exhaustion", "restored policy refusal"])(
    "accounts completed candidates with the real runner: %s",
    async (outcome) => {
      const exhausted = outcome === "fallback exhaustion";
      const refused = outcome === "restored policy refusal";
      const { result } = await runEntry(
        "run-real-fallback-accounting",
        async (provider, model) => {
          const primary = model === "gpt-5.6";
          const candidate = makeResult(provider, model, refused);
          if (!refused && (primary || exhausted)) {
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
            ...candidate.meta.agentMeta!,
            usage: { input: primary ? 100 : 200, cost: { total: primary ? 0.2 : 0.7 } },
            ...(refused ? {} : { lastCallUsage: { input: primary ? 90 : 20 } }),
          };
          return candidate;
        },
        undefined,
        refused ? undefined : ["openai/gpt-5.6-mini"],
      );
      expect(result.meta.agentMeta).toMatchObject({
        usage: { input: 300, cost: { total: expect.closeTo(0.9, 9) } },
      });
      if (refused) {
        expect(result.meta.agentMeta?.model).toBe("gpt-5.6");
        expect(result.payloads).toEqual([{ text: "policy refusal", isError: true }]);
      } else {
        expect(result.meta.agentMeta?.lastCallUsage).toEqual({ input: 20 });
      }
    },
  );

  it("propagates a recognized provider error thrown after the Daybreak retry delivered", async () => {
    const failure = retryFailure("daybreak overloaded after delivering", "overloaded");
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
    const profileId = "openai:default";
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: { type: "api_key", provider: "openai", key: "sk-test" },
      },
    };
    authStoreRuntimeMocks.state.store = authStore;
    const failure = retryFailure("daybreak entitlement denied", "auth");
    let primaryAttempts = 0;
    const runCandidate: RunCandidate = async (provider, model, options) => {
      authFailurePolicies.push(options.authProfileFailurePolicy);
      if (model === "gpt-daybreak-blue-latest") {
        const reason = resolveAuthProfileFailureReason({
          failoverReason: "auth",
          providerStarted: true,
          policy: options.authProfileFailurePolicy,
        });
        if (reason) {
          await markAuthProfileFailure({ store: authStore, profileId, reason, modelId: model });
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
