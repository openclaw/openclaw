import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
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

const retryModel = "gpt-5.6-sol";
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
  runId: string,
  runCandidate: EntryParams["runCandidate"] = async (provider, model) =>
    makeRefusalResult(provider, model),
  overrides: Partial<Omit<EntryParams, "runCandidate" | "identity">> = {},
) {
  return runEmbeddedAgentEntry({
    selection: {
      cfg: {
        agents: {
          defaults: { embeddedAgent: { cyberFailover: { model: `openai/${retryModel}` } } },
        },
      },
      provider: "openai",
      model: "gpt-5.6",
    },
    identity: { runId, agentId: "main", sessionId: "session-1" },
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
    params.model === retryModel ? Promise.reject(error) : runFallback(params),
  );
}

describe("runEmbeddedAgentEntry cyber failover", () => {
  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    resetFallbackSkipCacheForTest();
    runWithModelFallback.mockReset().mockImplementation(runFallback);
  });
  afterEach(clearRuntimeConfigSnapshot);

  it("retries a replay-safe OpenAI cyber refusal once on the configured target without changing selection", async () => {
    const reconcile = vi.fn(async () => {});
    const runCandidate = vi.fn<EntryParams["runCandidate"]>(async (provider, model) =>
      model === retryModel ? makeResult({ provider, model }) : makeRefusalResult(provider, model),
    );
    const result = await runEntry("run-cyber-escalation", runCandidate, {
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

  it("preserves the original refusal and cools off an unauthorized retry target", async () => {
    failRetry(Object.assign(new Error("401 unauthorized"), { status: 401 }));
    const first = await runEntry("run-cyber-cooloff");
    const second = await runEntry("run-cyber-cooloff");
    expect([first.model, second.model]).toEqual(["gpt-5.6", "gpt-5.6"]);
    expect(first.result.payloads).toEqual([{ text: "policy refusal", isError: true }]);
    expect(searchedModels()).toEqual(["gpt-5.6", retryModel, "gpt-5.6"]);
  });

  it.each([true, false])("propagates a retry throw (terminal stop=%s)", async (terminalStop) => {
    const thrown = new Error(
      terminalStop ? "recorded terminal stop" : "attempt committed work; cannot fall back",
    );
    if (terminalStop) {
      recordModelFallbackStop(thrown);
    }
    failRetry(thrown);
    await expect(runEntry("run-cyber-throw")).rejects.toBe(thrown);
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
        "run-cyber-preserve-returned",
        async (provider, model) => {
          if (model === retryModel) {
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

  it("keeps a cyber refusal terminal for a strict model selection", async () => {
    const result = await runEntry("run-cyber-strict", undefined, {
      selection: { cfg: {}, provider: "openai", model: "gpt-5.6", fallbacksOverride: [] },
    });
    expect(searchedModels()).toEqual(["gpt-5.6"]);
    expect(result.model).toBe("gpt-5.6");
    expect(result.result.payloads).toEqual([{ text: "policy refusal", isError: true }]);
  });

  it("restores the original refusal display when the configured retry fails", async () => {
    const displayChanges: Array<{ text: string; visible: boolean }> = [];
    await runEntry("run-cyber-transcript", async (provider, model, options) => {
      const retry = model === retryModel;
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
  });
});
