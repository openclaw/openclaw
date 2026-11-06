import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../admitted-run-context.js";
import { recordModelFallbackStop } from "../failover-error.js";
import { resetFallbackSkipCacheForTest } from "../fallback-skip-cache.test-support.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { runEmbeddedAgentEntry } from "./run-entry.js";
import {
  createDirectHarness,
  initialAttemptOptions,
  makeResult,
  type FallbackRunnerParams,
} from "./run-entry.test-support.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const retryModel = "gpt-5.6";
const cyberRefusal = { provider: "openai", category: "cyber" } as const;
const cyberCode = "OPENAI_CYBER_POLICY_REFUSAL";
const runWithModelFallback = vi.hoisted(() => vi.fn<typeof runFallback>());

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
    setRuntimeConfigSnapshot({});
    resetFallbackSkipCacheForTest();
    runWithModelFallback.mockReset().mockImplementation(runFallback);
  });
  afterEach(clearRuntimeConfigSnapshot);

  it.each([false, true])(
    "requires an explicit Blue grant for fallback (granted=%s)",
    async (granted) => {
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "fallback-role",
        scopes: ["operator.admin"],
        assertCurrent() {},
        rolePolicy: {
          sessionAccessCap: "none",
          sandboxRequired: false,
          agents: "*",
          accessPrograms: { cyber: granted ? ["daybreak_blue"] : [] },
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
        expect(candidate).toHaveBeenCalledTimes(granted ? 2 : 1);
        if (granted) {
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
