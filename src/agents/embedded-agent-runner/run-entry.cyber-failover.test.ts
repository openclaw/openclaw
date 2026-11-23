import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeConfig from "../../config/runtime-snapshot.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { createTestOperatorAuthority } from "../admitted-run-context.test-support.js";
import * as authStoreRuntime from "../auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { isProfileInCooldown, markAuthProfileFailure } from "../auth-profiles/usage.js";
import { FailoverError, recordModelFallbackStop } from "../failover-error.js";
import { resetFallbackSkipCacheForTest } from "../fallback-skip-cache.test-support.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { runEmbeddedAgentEntry } from "./run-entry.js";
import {
  makeResult as makeBaseResult,
  createDirectHarness,
  initialAttemptOptions,
  makeResult,
  type FallbackRunnerParams,
} from "./run-entry.test-support.js";
import { resolveAuthProfileFailureReason } from "./run/auth-profile-failure-policy.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const retryModel = "gpt-5.6";
const cyberRefusal = { provider: "openai", category: "cyber" } as const;
const cyberCode = "OPENAI_CYBER_POLICY_REFUSAL";
type FallbackRunner =
  typeof import("../model-fallback-runner.js").runWithModelFallback<EmbeddedAgentRunResult>;
const runWithModelFallback = vi.hoisted(() => vi.fn<FallbackRunner>());

// mock-isolation: Drive fallback outcomes without invoking provider runtimes.
vi.mock("../model-fallback-runner.js", () => ({ runWithModelFallback }));
vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));
vi.mock("../harness/selection.js", () => ({
  selectAgentHarness: vi.fn(() => ({ id: "openclaw", contextEngineHostCapabilities: [] })),
}));

async function runFallback(params: FallbackRunnerParams) {
  const candidate = await params.run(params.provider, params.model, initialAttemptOptions(params));
  const classification = await params.classifyResult?.({
    result: candidate,
    provider: params.provider,
    model: params.model,
    attempt: 1,
    total: 1,
  });
  return {
    outcome: classification ? ("exhausted" as const) : ("completed" as const),
    result: candidate,
    provider: params.provider,
    model: params.model,
    attempts: [],
  };
}

function makeRefusalResult(provider: string, model: string): EmbeddedAgentRunResult {
  const result = makeResult({ provider, model });
  result.payloads = [{ text: "policy refusal", isError: true }];
  result.meta.agentMeta = {
    sessionId: "session-1",
    provider,
    model,
    agentHarnessId: "openclaw",
    providerRefusal: { ...cyberRefusal },
  };
  return result;
}

type EntryParams = Parameters<typeof runEmbeddedAgentEntry<EmbeddedAgentRunResult>>[0];

function runEntry(
  runCandidate: EntryParams["runCandidate"] = async (provider, model) =>
    makeRefusalResult(provider, model),
  overrides: Partial<Omit<EntryParams, "runCandidate" | "identity">> = {},
) {
  return runEmbeddedAgentEntry({
    selection: {
      cfg: {
        agents: {
          defaults: { embeddedAgent: { cyberFailover: { mode: "auto" } } },
        },
      },
      provider: "openai",
      model: "gpt-5.6",
    },
    identity: { runId: "cyber-test", agentId: "main", sessionId: "session-1" },
    harness: createDirectHarness(),
    behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
    sessionOverride: { kind: "preserve" },
    ...overrides,
    runCandidate,
  });
}

const searchedModels = () => runWithModelFallback.mock.calls.map(([{ model }]) => model);
function failRetry(error: Error) {
  runWithModelFallback.mockImplementation((params) =>
    runWithModelFallback.mock.calls.length === 2 ? Promise.reject(error) : runFallback(params),
  );
}

describe("runEmbeddedAgentEntry cyber failover", () => {
  beforeEach(() => {
    runtimeConfig.setRuntimeConfigSnapshot({});
    resetFallbackSkipCacheForTest();
    runWithModelFallback.mockReset().mockImplementation(runFallback);
  });
  afterEach(runtimeConfig.clearRuntimeConfigSnapshot);

  it.each([
    { scope: "operator.admin", grants: undefined, allowed: true },
    { scope: "operator.write", grants: undefined, allowed: false },
    { scope: "operator.admin", grants: [] as const, allowed: false },
    { scope: "operator.write", grants: ["daybreak_blue"] as const, allowed: true },
  ])(
    "honors $scope authority and ceiling $grants for automatic fallback",
    async ({ scope, grants, allowed }) => {
      const authority = createTestOperatorAuthority({
        profileId: "fallback-role",
        scopes: [scope],
        assertCurrent() {},
        rolePolicy: {
          sessionAccessCap: "none",
          sandboxRequired: false,
          agents: "*",
          ...(grants ? { accessPrograms: { cyber: grants } } : {}),
        },
      });
      const admission = prepareSystemAgentRunAdmission(
        {},
        "cyber-test",
        "main",
        "test",
        undefined,
        authority,
      );
      const candidate = vi.fn<EntryParams["runCandidate"]>(async (provider, model, options) =>
        options.isFallbackRetry
          ? makeResult({ provider, model })
          : makeRefusalResult(provider, model),
      );
      try {
        await runEntry(candidate, { preparedRunAdmission: admission });
        expect(candidate).toHaveBeenCalledTimes(allowed ? 2 : 1);
        if (allowed) {
          expect(candidate.mock.calls[1]?.[2].cyberAccessProgram).toBe("daybreak_blue");
        }
      } finally {
        admission.close();
      }
    },
  );

  it.each([{ fallbacksOverride: undefined }, { fallbacksOverride: [] as string[] }])(
    "retries the same model with Blue access even for a strict selection (%j)",
    async ({ fallbacksOverride }) => {
      const reconcile = vi.fn(async () => {});
      const runCandidate = vi.fn<EntryParams["runCandidate"]>(async (provider, model, options) => {
        if (options.isFallbackRetry) {
          return makeResult({ provider, model });
        }
        const result = makeRefusalResult(provider, model);
        result.meta.agentMeta!.providerRefusal = {
          ...cyberRefusal,
          authProfileId: "openai:pinned",
          accessProgram: "standard",
        };
        return result;
      });
      const result = await runEntry(runCandidate, {
        selection: { cfg: {}, provider: "openai", model: "gpt-5.6", fallbacksOverride },
        sessionOverride: { kind: "reconcile-completed", reconcile },
      });
      expect(searchedModels()).toEqual(["gpt-5.6", "gpt-5.6"]);
      expect(runWithModelFallback.mock.calls[1]?.[0].userLockedAuthProfileId).toBe("openai:pinned");
      expect(runCandidate.mock.calls[1]?.[2]).toMatchObject({
        cyberAccessProgram: "daybreak_blue",
        authProfileId: "openai:pinned",
        agentHarnessRuntimeOverride: "openclaw",
        resolvedModelSelection: { provider: "openai", modelId: "gpt-5.6" },
      });
      expect(result.result.payloads).toEqual([{ text: "recovered" }]);
      await result.settleSessionOverride();
      expect(reconcile).not.toHaveBeenCalled();
    },
  );

  it.each(["daybreak_blue", "daybreak_red"] as const)(
    "does not retry or downgrade %s",
    async (accessProgram) => {
      const runCandidate = vi.fn<EntryParams["runCandidate"]>(async (provider, model) => {
        const result = makeRefusalResult(provider, model);
        result.meta.agentMeta!.providerRefusal = { ...cyberRefusal, accessProgram };
        return result;
      });
      await runEntry(runCandidate);
      expect(runCandidate).toHaveBeenCalledTimes(1);
    },
  );

  it("does not escalate an explicit Standard selection", async () => {
    const runCandidate = vi.fn<EntryParams["runCandidate"]>(async (provider, model) =>
      makeRefusalResult(provider, model),
    );
    await runEntry(runCandidate, {
      selection: { cfg: {}, provider: "openai", model: "gpt-5.6", cyberAccessProgram: "standard" },
    });
    expect(runCandidate).toHaveBeenCalledTimes(1);
  });

  it("retries a replay-safe OpenAI cyber refusal once with Blue Access without changing selection", async () => {
    const reconcile = vi.fn(async () => {});
    const runCandidate = vi.fn<EntryParams["runCandidate"]>(async (provider, model, options) =>
      options.isFallbackRetry
        ? makeResult({ provider, model })
        : makeRefusalResult(provider, model),
    );
    const result = await runEntry(runCandidate, {
      sessionOverride: { kind: "reconcile-completed", reconcile },
    });
    expect(
      runCandidate.mock.calls.map(([provider, model, options]) => [
        provider,
        model,
        options.isFallbackRetry,
        options.modelRoutingProvenance.stage,
      ]),
    ).toEqual([
      ["openai", "gpt-5.6", false, "initial"],
      ["openai", retryModel, true, "fallback"],
    ]);
    expect(searchedModels()).toEqual(["gpt-5.6", retryModel]);
    expect(result).toMatchObject({ provider: "openai", model: retryModel });
    expect(result.result.payloads).toEqual([{ text: "recovered" }]);
    expect(result.attempts).toContainEqual(expect.objectContaining({ code: cyberCode }));
    expect(result.result.meta.executionTrace?.providerPolicyRetry).toEqual({
      category: "cyber",
      provider: "openai",
      model: retryModel,
    });
    await result.settleSessionOverride();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("propagates a retry's terminal stop", async () => {
    const thrown = new Error("recorded terminal stop");
    recordModelFallbackStop(thrown);
    failRetry(thrown);
    await expect(runEntry()).rejects.toBe(thrown);
  });

  const incomplete = { kind: "incomplete_turn", message: "retry failed mid-turn" } as const;
  it.each([
    ["replay-invalid work", { replayInvalid: true, error: incomplete }, false, true],
    ["live committed work", { error: incomplete }, true, false],
    ["aborted retry", { aborted: true }, false, false],
    ["tool warning", {}, false, null],
  ] as const)(
    "preserves the retry result after %s",
    async (kind, targetMeta, commit, retryNotice) => {
      let committed = false;
      const payloads =
        kind === "tool warning"
          ? [{ text: "Tool warning", isError: true }, { text: "Recovered answer" }]
          : [{ text: "retry did not complete", isError: true }];
      const result = await runEntry(
        async (provider, model, options) => {
          if (options.isFallbackRetry) {
            committed = commit;
            return {
              ...makeResult({ provider, model, meta: targetMeta }),
              payloads: structuredClone(payloads),
            };
          }
          return makeRefusalResult(provider, model);
        },
        { behavior: { kind: "command-rpc", hasCommittedSideEffect: () => committed } },
      );
      expect(result.model).toBe(retryModel);
      expect(result.result.payloads).toEqual(payloads);
      if (kind === "replay-invalid work") {
        expect(result.result.meta.replayInvalid).toBe(true);
      }
      if (retryNotice) {
        expect(result.attempts).toContainEqual(expect.objectContaining({ code: cyberCode }));
      } else if (retryNotice === false) {
        expect(result.result.meta.executionTrace?.providerPolicyRetry).toBeUndefined();
      }
    },
  );

  it("keeps a cyber refusal terminal when Access escalation is off", async () => {
    const result = await runEntry(undefined, {
      selection: {
        cfg: { agents: { defaults: { embeddedAgent: { cyberFailover: { mode: "off" } } } } },
        provider: "openai",
        model: "gpt-5.6",
        fallbacksOverride: [],
      },
    });
    expect(searchedModels()).toEqual(["gpt-5.6"]);
    expect(result.model).toBe("gpt-5.6");
    expect(result.result.payloads).toEqual([{ text: "policy refusal", isError: true }]);
  });

  it("restores the original refusal and its display, cooling off an unauthorized retry target", async () => {
    const displayChanges: Array<{ text: string; visible: boolean }> = [];
    const first = await runEntry(async (provider, model, options) => {
      const retry = options.isFallbackRetry;
      const message = makeAssistantMessageFixture({
        provider,
        model,
        errorMessage: retry ? "Retry target unauthorized" : "Original cyber refusal",
        diagnostics: retry
          ? undefined
          : [{ type: "provider_refusal", timestamp: 1, details: { ...cyberRefusal } }],
      });
      options.assistantErrorTranscript.record(message);
      options.assistantErrorTranscript.bindStream(message, (visible) => {
        displayChanges.push({ text: message.errorMessage ?? "", visible });
      });
      if (retry) {
        throw Object.assign(new Error("401 unauthorized"), { status: 401 });
      }
      const refusal = makeRefusalResult(provider, model);
      refusal.meta.error = { kind: "incomplete_turn", message: "Original cyber refusal" };
      return refusal;
    });
    expect(displayChanges.at(-1)).toEqual({ text: "Original cyber refusal", visible: true });
    const second = await runEntry();
    expect([first.model, second.model]).toEqual(["gpt-5.6", "gpt-5.6"]);
    expect(first.result.payloads).toEqual([{ text: "policy refusal", isError: true }]);
    expect(searchedModels()).toEqual(["gpt-5.6", retryModel, "gpt-5.6"]);
  });
});

describe("cyber failover against real fallback", () => {
  beforeEach(async () => {
    runtimeConfig.setRuntimeConfigSnapshot({});
    resetFallbackSkipCacheForTest();
    const actual = await vi.importActual<typeof import("../model-fallback-runner.js")>(
      "../model-fallback-runner.js",
    );
    runWithModelFallback.mockReset().mockImplementation(actual.runWithModelFallback);
  });
  afterEach(runtimeConfig.clearRuntimeConfigSnapshot);
  function makeFallbackResult(
    provider: string,
    model: string,
    refused = true,
  ): EmbeddedAgentRunResult {
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
      model: "gpt-5.6",
      reason,
    });
  }
  function runFallbackEntry(
    runId: string,
    runCandidate: RunCandidate,
    hasCommittedSideEffect = () => false,
    fallbacksOverride?: string[],
  ) {
    const config = {
      agents: {
        defaults: {
          embeddedAgent: { cyberFailover: { mode: "auto" as const } },
        },
      },
    };
    runtimeConfig.setRuntimeConfigSnapshot(config);
    return runEmbeddedAgentEntry({
      selection: { cfg: config, provider: "openai", model: "gpt-5.6", fallbacksOverride },
      identity: { runId, agentId: "main", sessionId: "session-1" },
      harness: createDirectHarness(),
      behavior: { kind: "command-rpc", hasCommittedSideEffect },
      sessionOverride: { kind: "preserve" },
      runCandidate,
    });
  }
  it("propagates a recognized provider error thrown after the Daybreak retry delivered", async () => {
    const failure = retryFailure("daybreak overloaded after delivering", "overloaded");
    let delivered = false;
    await expect(
      runFallbackEntry(
        "run-cyber-real-runner",
        async (provider, model, options) => {
          if (options.isFallbackRetry) {
            delivered = true;
            throw failure;
          }
          return makeFallbackResult(provider, model);
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
    using update = vi
      .spyOn(authStoreRuntime, "updateAuthProfileStoreWithLock")
      .mockRejectedValue(new Error("unexpected auth mutation"));
    const failure = retryFailure("daybreak entitlement denied", "auth");
    let primaryAttempts = 0;
    const runCandidate: RunCandidate = async (provider, model, options) => {
      authFailurePolicies.push(options.authProfileFailurePolicy);
      if (options.isFallbackRetry) {
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
      return makeFallbackResult(provider, model, primaryAttempts === 1);
    };

    const refusedResult = await runFallbackEntry("run-cyber-real-runner-clean", runCandidate);
    expect(refusedResult.model).toBe("gpt-5.6");
    expect(refusedResult.result.payloads).toEqual([{ text: "policy refusal", isError: true }]);
    expect(authStore.usageStats?.[profileId]).toBeUndefined();
    expect(update).not.toHaveBeenCalled();

    const recoveredResult = await runFallbackEntry("run-cyber-real-runner-recovered", runCandidate);
    expect(recoveredResult.model).toBe("gpt-5.6");
    expect(recoveredResult.result.payloads).toEqual([{ text: "primary model recovered" }]);
    expect(authFailurePolicies).toEqual([undefined, "local", undefined]);
  });
});
