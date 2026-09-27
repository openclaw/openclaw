import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { isProfileInCooldown, markAuthProfileFailure } from "../auth-profiles/usage.js";
import { FailoverError } from "../failover-error.js";
import { resetFallbackSkipCacheForTest } from "../fallback-skip-cache.test-support.js";
import { runEmbeddedAgentEntry } from "./run-entry.js";
import { resolveAuthProfileFailureReason } from "./run/auth-profile-failure-policy.js";
import type { AuthProfileFailurePolicy } from "./run/auth-profile-failure-policy.types.js";
import type { EmbeddedAgentRunResult } from "./types.js";

// This file deliberately runs the real `runWithModelFallback`. The committed-work
// contract that protects a delivered reply lives in the runner itself
// (`canFallbackAfterError` -> rethrow), so a mocked runner cannot prove that the
// cyber-escalation catch honors it.
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

function makeRefusalResult(params: { provider: string; model: string }): EmbeddedAgentRunResult {
  return {
    payloads: [{ text: "policy refusal", isError: true }],
    meta: {
      durationMs: 10,
      aborted: false,
      providerStarted: true,
      stopReason: "completed",
      agentMeta: {
        sessionId: "session-1",
        provider: params.provider,
        model: params.model,
        agentHarnessId: "openclaw",
        providerRefusal: { provider: "openai", category: "cyber" },
      },
    },
  };
}

function makeSuccessResult(params: { provider: string; model: string }): EmbeddedAgentRunResult {
  return {
    payloads: [{ text: "primary model recovered" }],
    meta: {
      durationMs: 10,
      aborted: false,
      providerStarted: true,
      stopReason: "completed",
      agentMeta: {
        sessionId: "session-1",
        provider: params.provider,
        model: params.model,
        agentHarnessId: "openclaw",
      },
    },
  };
}

function makeAuthStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:default": { type: "api_key", provider: "openai", key: "sk-test" },
    },
  };
}

describe("runEmbeddedAgentEntry cyber failover against the real fallback runner", () => {
  beforeEach(() => {
    resetFallbackSkipCacheForTest();
    authStoreRuntimeMocks.state.store = undefined;
    authStoreRuntimeMocks.updateAuthProfileStoreWithLock.mockClear();
  });

  it("propagates a recognized provider error thrown after the Daybreak retry delivered", async () => {
    // `overloaded` is an ordinary failover-class reason, so error classification
    // alone would call this retry interchangeable with the refusal it replaced.
    // The reply already went out, so the runner rethrows and the escalation must
    // not substitute the initial refusal.
    const failure = new FailoverError("daybreak overloaded after delivering", {
      provider: "openai",
      model: "gpt-daybreak-blue-latest",
      reason: "overloaded",
    });
    let delivered = false;

    await expect(
      runEmbeddedAgentEntry({
        selection: { cfg: {}, provider: "openai", model: "gpt-5.6" },
        identity: { runId: "run-cyber-real-runner", agentId: "main", sessionId: "session-1" },
        harness: {
          workspaceDir: "/tmp/workspace",
          preparation: { kind: "direct" as const },
          resolveRuntimeOverride: () => undefined,
        },
        behavior: { kind: "command-rpc", hasCommittedSideEffect: () => delivered },
        sessionOverride: { kind: "preserve" },
        runCandidate: async (provider, model) => {
          if (model === "gpt-daybreak-blue-latest") {
            delivered = true;
            throw failure;
          }
          return makeRefusalResult({ provider, model });
        },
      }),
    ).rejects.toBe(failure);

    expect(delivered).toBe(true);
  });

  it.each([
    {
      name: "an existing config without cyber failover keys",
      cfg: {},
    },
    {
      name: "an explicit cyber failover config",
      cfg: {
        agents: {
          defaults: {
            embeddedAgent: {
              cyberFailover: {
                mode: "auto" as const,
                model: "openai/gpt-daybreak-blue-latest",
                cooloffMs: 600_000,
              },
            },
          },
        },
      },
    },
  ] satisfies Array<{ name: string; cfg: OpenClawConfig }>)(
    "keeps primary auth usable after a denied Daybreak retry for $name",
    async ({ cfg }) => {
      const authFailurePolicies: Array<string | undefined> = [];
      const authStore = makeAuthStore();
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
        return primaryAttempts === 1
          ? makeRefusalResult({ provider, model })
          : makeSuccessResult({ provider, model });
      };

      const refusedResult = await runEmbeddedAgentEntry({
        selection: { cfg, provider: "openai", model: "gpt-5.6" },
        identity: {
          runId: "run-cyber-real-runner-clean",
          agentId: "main",
          sessionId: "session-1",
        },
        harness: {
          workspaceDir: "/tmp/workspace",
          preparation: { kind: "direct" as const },
          resolveRuntimeOverride: () => undefined,
        },
        behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
        sessionOverride: { kind: "preserve" },
        runCandidate,
      });

      expect(refusedResult.model).toBe("gpt-5.6");
      expect(refusedResult.result.payloads).toEqual([{ text: "policy refusal", isError: true }]);
      expect(authStore.usageStats?.[profileId]).toBeUndefined();
      expect(authStoreRuntimeMocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();

      const recoveredResult = await runEmbeddedAgentEntry({
        selection: { cfg, provider: "openai", model: "gpt-5.6" },
        identity: {
          runId: "run-cyber-real-runner-recovered",
          agentId: "main",
          sessionId: "session-1",
        },
        harness: {
          workspaceDir: "/tmp/workspace",
          preparation: { kind: "direct" as const },
          resolveRuntimeOverride: () => undefined,
        },
        behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
        sessionOverride: { kind: "preserve" },
        runCandidate,
      });

      expect(recoveredResult.model).toBe("gpt-5.6");
      expect(recoveredResult.result.payloads).toEqual([{ text: "primary model recovered" }]);
      expect(authFailurePolicies).toEqual([undefined, "local", undefined]);
    },
  );
});
