import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordModelFallbackStop } from "../failover-error.js";
import { resetFallbackSkipCacheForTest } from "../fallback-skip-cache.test-support.js";
import { runEmbeddedAgentEntry } from "./run-entry.js";
import {
  createDirectHarness,
  initialAttemptOptions,
  makeResult,
  type FallbackRunnerParams,
} from "./run-entry.test-support.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const state = vi.hoisted(() => ({
  runWithModelFallback: vi.fn<typeof runFallback>(),
}));

vi.mock("../model-fallback-runner.js", () => ({
  runWithModelFallback: (params: FallbackRunnerParams) => state.runWithModelFallback(params),
}));
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
  return {
    ...makeResult({ provider, model }),
    payloads: [{ text: "policy refusal", isError: true }],
    meta: {
      ...makeResult({ provider, model }).meta,
      agentMeta: {
        sessionId: "session-1",
        provider,
        model,
        agentHarnessId: "openclaw",
        providerRefusal: { provider: "openai", category: "cyber" },
      },
    },
  };
}

type EntryParams = Parameters<typeof runEmbeddedAgentEntry<EmbeddedAgentRunResult>>[0];

function runEntry(
  runId: string,
  runCandidate: EntryParams["runCandidate"] = async (provider, model) =>
    makeRefusalResult(provider, model),
  overrides: Partial<Omit<EntryParams, "runCandidate" | "identity">> = {},
) {
  return runEmbeddedAgentEntry({
    selection: { cfg: {}, provider: "openai", model: "gpt-5.6" },
    identity: { runId, agentId: "main", sessionId: "session-1" },
    harness: createDirectHarness(),
    behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
    sessionOverride: { kind: "preserve" },
    ...overrides,
    runCandidate,
  });
}

function searchedModels() {
  return state.runWithModelFallback.mock.calls.map(([params]) => params.model);
}

describe("runEmbeddedAgentEntry cyber failover", () => {
  beforeEach(() => {
    resetFallbackSkipCacheForTest();
    state.runWithModelFallback.mockReset().mockImplementation(runFallback);
  });

  it("retries a replay-safe OpenAI cyber refusal once on Daybreak without changing selection", async () => {
    const candidateCalls: Array<{
      provider: string;
      model: string;
      isFallbackRetry: boolean;
      routingStage: string;
    }> = [];
    const reconciled: Array<{ provider: string; model: string }> = [];
    const result = await runEntry(
      "run-cyber-escalation",
      async (provider, model, options) => {
        candidateCalls.push({
          provider,
          model,
          isFallbackRetry: options.isFallbackRetry,
          routingStage: options.modelRoutingProvenance.stage,
        });
        return model === "gpt-daybreak-blue-latest"
          ? makeResult({ provider, model })
          : makeRefusalResult(provider, model);
      },
      {
        sessionOverride: {
          kind: "reconcile-completed",
          reconcile: async (candidate) => {
            reconciled.push(candidate);
          },
        },
      },
    );

    expect(candidateCalls).toEqual([
      { provider: "openai", model: "gpt-5.6", isFallbackRetry: false, routingStage: "initial" },
      {
        provider: "openai",
        model: "gpt-daybreak-blue-latest",
        isFallbackRetry: true,
        routingStage: "fallback",
      },
    ]);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-daybreak-blue-latest");
    expect(result.result.payloads).toEqual([{ text: "recovered" }]);
    expect(result.attempts).toContainEqual(
      expect.objectContaining({ code: "OPENAI_CYBER_POLICY_REFUSAL" }),
    );
    expect(result.result.meta.executionTrace?.providerPolicyRetry).toEqual({
      category: "cyber",
      provider: "openai",
      model: "gpt-daybreak-blue-latest",
    });
    await result.settleSessionOverride();
    expect(reconciled).toEqual([]);
  });

  it("preserves the original refusal and cools off an unauthorized Daybreak target", async () => {
    state.runWithModelFallback.mockImplementation(async (params) => {
      if (params.model === "gpt-daybreak-blue-latest") {
        throw Object.assign(new Error("401 unauthorized"), { status: 401 });
      }
      return runFallback(params);
    });
    const first = await runEntry("run-cyber-cooloff");
    const second = await runEntry("run-cyber-cooloff");
    expect(first.model).toBe("gpt-5.6");
    expect(first.result.payloads).toEqual([{ text: "policy refusal", isError: true }]);
    expect(second.model).toBe("gpt-5.6");
    expect(searchedModels()).toEqual(["gpt-5.6", "gpt-daybreak-blue-latest", "gpt-5.6"]);
  });

  it("keeps a failed Daybreak attempt that already committed work", async () => {
    const result = await runEntry("run-cyber-committed", async (provider, model) =>
      model === "gpt-daybreak-blue-latest"
        ? {
            ...makeResult({
              provider,
              model,
              meta: {
                replayInvalid: true,
                error: { kind: "incomplete_turn", message: "Daybreak failed mid-turn" },
              },
            }),
            payloads: [{ text: "daybreak failed after running a tool", isError: true }],
          }
        : makeRefusalResult(provider, model),
    );
    expect(result.model).toBe("gpt-daybreak-blue-latest");
    expect(result.result.meta.replayInvalid).toBe(true);
    expect(result.result.payloads).toEqual([
      { text: "daybreak failed after running a tool", isError: true },
    ]);
    expect(result.attempts).toContainEqual(
      expect.objectContaining({ code: "OPENAI_CYBER_POLICY_REFUSAL" }),
    );
  });

  it.each([
    {
      name: "a recorded terminal stop",
      makeError: () => {
        const error = new Error("recorded terminal stop");
        recordModelFallbackStop(error);
        return error;
      },
    },
    {
      name: "an unclassified committed-work throw",
      makeError: () => new Error("attempt committed work; cannot fall back"),
    },
  ])("propagates $name thrown by the Daybreak retry", async ({ makeError }) => {
    const thrown = makeError();
    state.runWithModelFallback.mockImplementation(async (params) => {
      if (params.model === "gpt-daybreak-blue-latest") {
        throw thrown;
      }
      return runFallback(params);
    });
    await expect(runEntry("run-cyber-throw")).rejects.toBe(thrown);
  });

  it.each([
    {
      name: "live committed side effects",
      targetMeta: { error: { kind: "incomplete_turn" as const, message: "failed" } },
      commit: true,
    },
    { name: "an aborted retry", targetMeta: { aborted: true }, commit: false },
  ])("preserves a returned Daybreak result with $name", async ({ targetMeta, commit }) => {
    let committed = false;
    const result = await runEntry(
      "run-cyber-preserve-returned",
      async (provider, model) => {
        if (model === "gpt-daybreak-blue-latest") {
          committed = commit;
          return {
            ...makeResult({ provider, model, meta: targetMeta }),
            payloads: [{ text: "Daybreak did not complete", isError: true }],
          };
        }
        return makeRefusalResult(provider, model);
      },
      { behavior: { kind: "command-rpc", hasCommittedSideEffect: () => committed } },
    );
    expect(result.model).toBe("gpt-daybreak-blue-latest");
    expect(result.result.payloads).toEqual([{ text: "Daybreak did not complete", isError: true }]);
    expect(result.result.meta.executionTrace?.providerPolicyRetry).toBeUndefined();
  });

  it("keeps a recovered Daybreak answer alongside a replay-safe tool warning", async () => {
    const result = await runEntry("run-cyber-warning", async (provider, model) =>
      model === "gpt-daybreak-blue-latest"
        ? {
            ...makeResult({ provider, model }),
            payloads: [{ text: "Tool warning", isError: true }, { text: "Recovered answer" }],
          }
        : makeRefusalResult(provider, model),
    );
    expect(result.model).toBe("gpt-daybreak-blue-latest");
    expect(result.result.payloads).toEqual([
      { text: "Tool warning", isError: true },
      { text: "Recovered answer" },
    ]);
  });

  it("keeps a cyber refusal terminal for a strict model selection", async () => {
    const result = await runEntry("run-cyber-strict", undefined, {
      selection: { cfg: {}, provider: "openai", model: "gpt-5.6", fallbacksOverride: [] },
    });
    expect(searchedModels()).toEqual(["gpt-5.6"]);
    expect(result.model).toBe("gpt-5.6");
    expect(result.result.payloads).toEqual([{ text: "policy refusal", isError: true }]);
  });

  it("restores the original refusal display when Daybreak fails", async () => {
    const { makeAssistantMessageFixture } =
      await import("../test-helpers/assistant-message-fixtures.js");
    const displayChanges: Array<{ text: string; visible: boolean }> = [];
    await runEntry("run-cyber-transcript", async (provider, model, options) => {
      const retry = model === "gpt-daybreak-blue-latest";
      const message = makeAssistantMessageFixture({
        provider,
        model,
        errorMessage: retry ? "Daybreak unauthorized" : "Original cyber refusal",
        diagnostics: retry
          ? undefined
          : [
              {
                type: "provider_refusal",
                timestamp: 1,
                details: { provider: "openai", category: "cyber" },
              },
            ],
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
