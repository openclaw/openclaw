import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeConfig from "../../config/runtime-snapshot.js";
import * as runRegistry from "../../infra/agent-run-registry.js";
import { makeModel } from "./model.test-harness.js";
import { runEmbeddedAgentEntry, setupRunEntryTestState } from "./run-entry.test-harness.js";
import {
  createDirectHarness,
  makeResult,
  recordTurnAttempt,
  initialAttemptOptions,
  fallbackAttemptOptions,
  type FallbackRunnerParams,
} from "./run-entry.test-support.js";

const state = setupRunEntryTestState();

beforeEach(() => runtimeConfig.setRuntimeConfigSnapshot({}));
afterEach(runtimeConfig.clearRuntimeConfigSnapshot);

type EntryParams = Parameters<typeof runEmbeddedAgentEntry>[0];
const primaryRoute = { provider: "primary-provider", model: "primary-model" };
const fallbackRoute = { provider: "fallback-provider", model: "fallback-model" };
const sameModelRetry = { result: "same_model_transient" as const, reason: "rate_limit" };
const entryIdentity = { agentId: "main", sessionId: "session-1" };
const commandRpc = { kind: "command-rpc" as const, hasCommittedSideEffect: () => false };
const channelDelivery: EntryParams["behavior"] = {
  kind: "channel-delivery",
  readDeliveryEvidence: () => ({
    hasDirectlySentBlockReply: false,
    hasBlockReplyPipelineOutput: false,
    hasRetryBlockedDelivery: false,
  }),
};

function runEntry({
  runId = "run-entry",
  runCandidate = async (provider, model, { isFallbackRetry }) =>
    makeResult({ provider, model, classification: isFallbackRetry ? undefined : "empty" }),
  ...params
}: Partial<EntryParams> & { runId?: string }) {
  return runEmbeddedAgentEntry({
    selection: { cfg: {}, ...primaryRoute },
    identity: { runId, ...entryIdentity },
    harness: createDirectHarness(),
    behavior: commandRpc,
    sessionOverride: { kind: "preserve" },
    runCandidate,
    ...params,
  });
}

type CandidateResult = Awaited<ReturnType<FallbackRunnerParams["run"]>>;
function usePrimaryFallback(
  inspect?: (params: FallbackRunnerParams, result: CandidateResult) => void | Promise<void>,
  outcome: "completed" | "exhausted" = "completed",
) {
  state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
    const { provider, model } = params;
    const result = await params.run(provider, model, initialAttemptOptions(params));
    await inspect?.(params, result);
    return { outcome, result, provider, model, attempts: [] };
  });
}

function classify(params: FallbackRunnerParams, result: CandidateResult, total = 2) {
  return params.classifyResult?.({
    result,
    provider: params.provider,
    model: params.model,
    attempt: 1,
    total,
  });
}

function receiptFor(runId: string, provider: string, model: string, responseModel = model) {
  return {
    runId,
    sessionId: "session-1",
    turnId: "turn-1",
    requested: { provider, model },
    effective: { provider, model, responseModel },
    successfulToolNames: [] as string[],
    rerouted: false,
  };
}

async function requesterFixture(runId: string, childId: string) {
  const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
  const { prepareSystemAgentRunAdmission } = await import("../admitted-run-context.js");
  const { mergeAcceptedSessionSpawnsForRun } = await import("../accepted-session-spawn.js");
  const { createSubagentRunRecord } = await import("../subagent-test-fixtures.test-helpers.js");
  const { subagentRuns } = await import("../subagents/registry/subagent-registry-memory.js");
  const { saveSubagentRegistryChangesToSqlite, loadSubagentRegistryFromSqlite } =
    await import("../subagents/registry/subagent-registry-state.fixture.test-support.js");
  const fixture = await createOpenClawTestState({ label: "entry-requester-settlement" });
  runtimeConfig.setRuntimeConfigSnapshot({});
  const identity = {
    runId,
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
  };
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "entry-requester-test");
  const child = createSubagentRunRecord({
    runId: childId,
    requesterSessionKey: identity.sessionKey,
    requesterAgentId: identity.agentId,
    requesterTurnRunId: runId,
    expectsCompletionMessage: true,
    completion: { required: true },
    delivery: { status: "pending" },
  });
  return {
    identity,
    admission,
    child,
    subagentRuns,
    readChild: () => loadSubagentRegistryFromSqlite().get(childId),
    expectSettled() {
      const expected = { runId: childId, requesterTurnRunId: undefined };
      expect(subagentRuns.get(childId)).toMatchObject(expected);
      expect(loadSubagentRegistryFromSqlite().get(childId)).toMatchObject(expected);
    },
    acceptChild: () =>
      mergeAcceptedSessionSpawnsForRun(admission.operationalRunInstance, [
        {
          runId: childId,
          childSessionKey: child.childSessionKey,
          expectsCompletionMessage: true,
        },
      ]),
    async seed() {
      subagentRuns.set(childId, child);
      saveSubagentRegistryChangesToSqlite(subagentRuns, [childId]);
      await admission.admit("embedded");
    },
    async [Symbol.asyncDispose]() {
      subagentRuns.delete(childId);
      admission.close();
      await fixture.cleanup();
    },
  };
}

const failureDefaults = {
  selection: { cfg: {}, provider: "provider", model: "model" },
  runId: "settle-exhausted",
};

describe("runEmbeddedAgentEntry", () => {
  it.each([
    { runtime: "cli", revokeAtCleanup: false, errorResult: false },
    { runtime: "embedded", revokeAtCleanup: false, errorResult: true },
    { runtime: "cli", revokeAtCleanup: true, errorResult: false },
  ] as const)(
    "classifies retained children before candidate acceptance ($runtime, revoked=$revokeAtCleanup, error=$errorResult)",
    async ({ runtime, revokeAtCleanup, errorResult }) => {
      const { withLocalSessionPlacementTurnSettlement } =
        await import("../session-placement-admission.js");
      await using f = await requesterFixture("retained-parent", "retained-child");
      const { identity, admission, child, subagentRuns } = f;
      const error = new Error("first provider failed after spawning");
      let placementReleased = false;
      let restoreCleanup: (() => void) | undefined;
      try {
        await f.seed();
        const runCandidate = vi.fn<EntryParams["runCandidate"]>(
          async (provider, model, options) => {
            if (!options.isFallbackRetry) {
              f.acceptChild();
              throw error;
            }
            if (revokeAtCleanup) {
              const settle = options.assistantErrorTranscript.settle.bind(
                options.assistantErrorTranscript,
              );
              const spy = vi
                .spyOn(options.assistantErrorTranscript, "settle")
                .mockImplementation((...args) => {
                  settle(...args);
                  admission.close();
                });
              restoreCleanup = () => spy.mockRestore();
            }
            const candidate = makeResult({
              provider,
              model,
              classification: "empty",
              meta: {
                executionTrace: { runner: runtime, attempts: [], fallbackUsed: true },
              },
            });
            if (errorResult) {
              candidate.meta.error = {
                kind: "incomplete_turn",
                message: "candidate incomplete",
                fallbackSafe: true,
              };
            }
            const result = await withLocalSessionPlacementTurnSettlement(
              identity,
              async () => {
                // CLI session persistence asks for this decision before releasing placement.
                expect(options.classifyResult(candidate)).toBeNull();
                expect(child.requesterTurnRunId).toBe(identity.runId);
                return candidate;
              },
              { preparedRunAdmission: admission, isFinalFallbackAttempt: false },
            );
            placementReleased = true;
            expect(subagentRuns.get(child.runId)?.requesterTurnRunId).toBe(identity.runId);
            return result;
          },
        );
        state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
          await expect(
            params.run(params.provider, params.model, {
              ...initialAttemptOptions(params),
              isFinalFallbackAttempt: false,
            }),
          ).rejects.toBe(error);
          const result = await params.run(fallbackRoute.provider, fallbackRoute.model, {
            ...fallbackAttemptOptions(params, "server_error"),
            isFinalFallbackAttempt: false,
          });
          expect(
            await params.classifyResult?.({ result, ...fallbackRoute, attempt: 2, total: 3 }),
          ).toBeNull();
          expect(child.requesterTurnRunId).toBe(identity.runId);
          return { outcome: "completed", result, ...fallbackRoute, attempts: [] };
        });
        const run = runEntry({
          ...failureDefaults,
          runCandidate,
          preparedRunAdmission: admission,
          identity,
        });
        if (revokeAtCleanup) {
          await expect(run).rejects.toThrow("settlement is closed");
          expect(f.readChild()).toMatchObject({
            requesterTurnRunId: identity.runId,
          });
          return;
        }
        const result = await run;
        expect(placementReleased).toBe(true);
        expect(runCandidate).toHaveBeenCalledTimes(2);
        expect(result.result.acceptedSessionSpawns).toHaveLength(1);
        f.expectSettled();
      } finally {
        restoreCleanup?.();
      }
    },
  );

  it("settles terminal failure when later candidates are skipped", async () => {
    await using f = await requesterFixture("failed-entry", "entry-failure-child");
    const { identity, admission, child } = f;
    await f.seed();
    const providerError = new Error("provider failed");
    const exhausted = new Error("all candidates failed or were skipped");
    const runCandidate = vi.fn(async () => {
      f.acceptChild();
      throw providerError;
    });
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await expect(
        params.run(params.provider, params.model, {
          ...initialAttemptOptions(params),
          isFinalFallbackAttempt: false,
        }),
      ).rejects.toBe(providerError);
      expect(f.readChild()?.requesterTurnRunId).toBe(identity.runId);
      throw exhausted;
    });
    await expect(
      runEntry({ ...failureDefaults, runCandidate, preparedRunAdmission: admission, identity }),
    ).rejects.toBe(exhausted);
    expect(runCandidate).toHaveBeenCalledOnce();
    expect(child.requesterTurnRunId).toBe(identity.runId);
    f.expectSettled();
  });

  it("does not finalize any candidate when fallback is exhausted", async () => {
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const preferredResult = await params.run(
        params.provider,
        params.model,
        initialAttemptOptions(params),
      );
      const latestResult = await params.run(
        fallbackRoute.provider,
        fallbackRoute.model,
        fallbackAttemptOptions(params, "unknown"),
      );
      return {
        outcome: "exhausted" as const,
        result: params.mergeExhaustedResult?.({ latestResult, preferredResult }) ?? latestResult,
        ...fallbackRoute,
        attempts: [],
      };
    });
    const result = await runEntry({
      ...failureDefaults,
      runCandidate: async (provider, model, options) => {
        recordTurnAttempt(options.onContextEngineTurnCandidate, provider);
        return makeResult({
          provider,
          model,
          classification: "empty",
          meta: {
            error: { kind: "incomplete_turn", message: `${provider} failed` },
            agentMeta: {
              sessionId: "session-1",
              provider,
              model,
              terminalReceipt: {
                ...receiptFor("settle-exhausted", provider, model),
                turnId: provider,
                assistantTranscriptIdempotencyKey: `saved-${provider}`,
              },
            },
          },
        });
      },
    });

    expect(result.result.meta.error?.message).toBe("provider failed");
    expect(result.terminal.metadata.assistantTranscriptIdempotencyKey).toBe(
      "saved-fallback-provider",
    );
    expect(state.finalizedAttempts).toEqual([]);
  });

  it("does not replay a thrown channel-delivery attempt that already delivered its reply (#113788)", async () => {
    const failure = new Error("insufficient quota");
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      // Thrown attempts bypass classification; the error backstop must block replay.
      await expect(
        params.run(params.provider, params.model, initialAttemptOptions(params)),
      ).rejects.toBe(failure);
      const allowed = await params.canFallbackAfterError?.({
        provider: params.provider,
        model: params.model,
        error: failure,
        attempt: 1,
        total: 2,
      });
      expect(allowed).toBe(false);
      throw failure;
    });
    const runCandidate = vi.fn<EntryParams["runCandidate"]>(async (_provider, _model, options) => {
      recordTurnAttempt(options.onContextEngineTurnCandidate, "candidate");
      throw failure;
    });

    await expect(
      runEntry({
        ...failureDefaults,
        runCandidate,
        selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
        identity: { runId: "channel-throw", agentId: "main", sessionId: "session-1" },
        behavior: {
          kind: "channel-delivery",
          readDeliveryEvidence: () => ({
            hasDirectlySentBlockReply: true,
            hasBlockReplyPipelineOutput: false,
            hasRetryBlockedDelivery: false,
          }),
        },
      }),
    ).rejects.toBe(failure);

    expect(runCandidate).toHaveBeenCalledTimes(1);
    expect(state.finalizedAttempts).toEqual([]);
  });

  it("keeps shared fallback and terminal behavior aligned across entry modes", async ({
    onTestFinished,
  }) => {
    const runMode = async (behavior: "channel-delivery" | "command-rpc") => {
      runRegistry.registerAgentRunContext("run-shared-fallback", {
        ...entryIdentity,
        sessionKey: "agent:main:chat",
      });
      onTestFinished(() => runRegistry.clearAgentRunContext("run-shared-fallback"));
      const candidateCalls: Array<typeof primaryRoute & { isFallbackRetry: boolean }> = [];
      const candidateLeases: object[] = [];
      const reconciled: Array<typeof primaryRoute> = [];
      const alreadyFinalized = state.finalizedAttempts.length;
      const releaseAcceptedTerminalWork = vi.fn();
      const onAcceptedTerminal = vi.fn(() => {
        expect(state.finalizedAttempts.slice(alreadyFinalized)).toEqual([]);
        return releaseAcceptedTerminalWork;
      });
      const result = await runEntry({
        runId: "run-shared-fallback",
        onAcceptedTerminal,
        behavior: behavior === "channel-delivery" ? channelDelivery : commandRpc,
        sessionOverride: {
          kind: "reconcile-completed",
          reconcile: async (candidate) => {
            reconciled.push(candidate);
          },
        },
        runCandidate: async (provider, model, options) => {
          expect(runRegistry.resolveProjectedAgentRunModel(entryIdentity)).toBeNull();
          runRegistry.recordAgentRunModel("run-shared-fallback", { provider, model });
          candidateCalls.push({ provider, model, isFallbackRetry: options.isFallbackRetry });
          candidateLeases.push(options.contextEngineLogicalTurnLease);
          recordTurnAttempt(
            options.onContextEngineTurnCandidate,
            options.isFallbackRetry ? "fallback" : "primary",
          );
          const candidate = makeResult({
            provider,
            model,
            classification: options.isFallbackRetry ? undefined : "empty",
          });
          if (options.isFallbackRetry) {
            candidate.meta = {
              ...candidate.meta,
              finalAssistantVisibleText: "fallback complete",
              finalAssistantRawText: "fallback complete",
              terminalReply: { disposition: "visible", text: "fallback complete" },
              executionTrace: {
                winnerProvider: provider,
                winnerModel: model,
                attempts: [
                  { provider, model, ...sameModelRetry },
                  { provider, model, result: "success" },
                ],
                fallbackUsed: false,
                runner: "embedded",
              },
            };
            candidate.meta.agentMeta!.terminalReceipt = {
              ...receiptFor("run-shared-fallback", provider, model, "producer-model"),
              assistantTranscriptIdempotencyKey: "selected-saved-reply",
            };
          }
          return candidate;
        },
      });
      expect(runRegistry.getAgentRunContext("run-shared-fallback")?.activeModel).toBeUndefined();
      expect(onAcceptedTerminal).toHaveBeenCalledOnce();
      expect(releaseAcceptedTerminalWork).toHaveBeenCalledOnce();
      expect(state.finalizedAttempts.slice(alreadyFinalized)).toEqual(["fallback"]);
      expect(candidateCalls).toEqual([
        { ...primaryRoute, isFallbackRetry: false },
        { ...fallbackRoute, isFallbackRetry: true },
      ]);
      await result.settleSessionOverride();
      await result.settleSessionOverride();
      return { result, candidateCalls, candidateLeases, reconciled };
    };

    const channel = await runMode("channel-delivery");
    const command = await runMode("command-rpc");

    expect(channel.candidateCalls).toEqual(command.candidateCalls);
    expect(channel.result).toMatchObject({
      outcome: "completed",
      ...fallbackRoute,
    });
    expect(channel.result.attempts).toEqual(command.result.attempts);
    expect(channel.result.terminal).toEqual(command.result.terminal);
    expect(channel.result.result.meta.executionTrace).toEqual({
      winnerProvider: "fallback-provider",
      winnerModel: "fallback-model",
      attempts: [
        {
          ...primaryRoute,
          result: "candidate_failed",
          reason: "format",
        },
        { ...fallbackRoute, ...sameModelRetry },
        { ...fallbackRoute, result: "success" },
      ],
      fallbackUsed: true,
      runner: "embedded",
    });
    const expectedReceipt = {
      requested: primaryRoute,
      effective: { ...fallbackRoute, responseModel: "producer-model" },
      rerouted: true,
    };
    expect(channel.result.result.meta.agentMeta?.terminalReceipt).toMatchObject(expectedReceipt);
    expect(channel.result.terminal.metadata).toMatchObject({
      assistantTranscriptIdempotencyKey: "selected-saved-reply",
      terminalReceipt: { ...expectedReceipt, terminalDisposition: "visible" },
    });
    expect(channel.result.terminal.metadata.terminalReply).toEqual({
      disposition: "visible",
      text: "fallback complete",
      modelRouteChange:
        "Model route changed: primary-provider/primary-model → fallback-provider/producer-model.",
    });
    expect(channel.candidateLeases[0]).toBe(channel.candidateLeases[1]);
    expect(state.selectAgentHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "fallback-provider",
        modelId: "fallback-model",
      }),
    );
    expect(channel.reconciled).toEqual(command.reconciled);
    expect(channel.reconciled).toEqual([fallbackRoute]);
  });

  it("preflights caller-resolved CLI hosts instead of the model harness", async () => {
    const resolveContextEngineHost = vi.fn((provider: string) => ({
      id: `cli:${provider}`,
      label: `CLI backend "${provider}"`,
      capabilities: [],
    }));

    await runEntry({
      runId: "cli-host-preflight",
      harness: {
        ...createDirectHarness(),
        resolveContextEngineHost,
      },
    });

    expect(resolveContextEngineHost.mock.calls).toEqual([
      ["primary-provider", "primary-model", undefined],
      ["fallback-provider", "fallback-model", undefined],
    ]);
    expect(state.selectAgentHarness).not.toHaveBeenCalled();
  });

  it("registers lazy harness plugins before selecting preflight hosts", async () => {
    const events: string[] = [];
    state.ensureSelectedAgentHarnessPlugin.mockImplementation(async (params: unknown) => {
      events.push(`ensure:${(params as { provider: string }).provider}`);
    });
    state.selectAgentHarness.mockImplementation(({ provider }: { provider: string }) => {
      events.push(`select:${provider}`);
      return {
        id: `${provider}-harness`,
        contextEngineHostCapabilities: [],
      };
    });

    await runEntry({
      runId: "lazy-plugin-preflight",
      harness: {
        ...createDirectHarness(),
        resolveRuntimeOverride: (provider) => `${provider}-harness`,
      },
    });

    expect(events).toEqual([
      "ensure:primary-provider",
      "select:primary-provider",
      "ensure:fallback-provider",
      "select:fallback-provider",
    ]);
  });

  it("leaves maintenance fallback classification to thrown candidate errors", async () => {
    usePrimaryFallback((params) => {
      expect(params.classifyResult).toBeUndefined();
      expect(params.mergeExhaustedResult).toBeUndefined();
    });
    const result = await runEntry({
      runId: "maintenance",
      behavior: { kind: "maintenance" },
      runCandidate: async (provider, model) => makeResult({ provider, model }),
    });

    expect(result.result.payloads).toEqual([{ text: "recovered" }]);
  });

  it("does not commit the accepted terminal after abort wins before fallback settlement", async () => {
    const abortController = new AbortController();
    const onAcceptedTerminal = vi.fn();
    usePrimaryFallback(() => abortController.abort("user_abort"));
    await runEntry({
      selection: { cfg: {}, provider: "provider", model: "model" },
      runId: "settle-after-abort",
      behavior: channelDelivery,
      abortSignal: abortController.signal,
      onAcceptedTerminal,
      runCandidate: async (provider, model, options) => {
        recordTurnAttempt(options.onContextEngineTurnCandidate, "candidate");
        return makeResult({ provider, model });
      },
    });

    expect(onAcceptedTerminal).not.toHaveBeenCalled();
    expect(state.finalizedAttempts).toEqual([]);
  });

  it.each(["committed side effect", "continuity failure"])(
    "settles an empty result after %s without reusing a replaced result's classification",
    async (settlement) => {
      const committed = settlement === "committed side effect";
      usePrimaryFallback(async (params, result) => {
        expect(await classify(params, result)).toBe(committed ? undefined : null);
      });
      const run = await runEntry({
        selection: { cfg: {}, provider: "provider", model: "model" },
        runId: "settle-result",
        behavior: { kind: "command-rpc", hasCommittedSideEffect: () => committed },
        runCandidate: async (provider, model, options) => {
          recordTurnAttempt(options.onContextEngineTurnCandidate, "candidate");
          const candidate = makeResult({ provider, model, classification: "empty" });
          expect(options.classifyResult(candidate)).toEqual(
            committed ? undefined : expect.objectContaining({ code: "empty_result" }),
          );
          return committed
            ? candidate
            : {
                ...candidate,
                payloads: [{ text: "continuity failed", isError: true }],
                meta: {
                  ...candidate.meta,
                  replayInvalid: true,
                  error: {
                    kind: "incomplete_turn",
                    message: "continuity failed",
                    fallbackSafe: false,
                  },
                },
              };
        },
      });
      expect(run.terminal.outcome.status).toBe(committed ? "ok" : "error");
      expect(run.result.meta.executionTrace?.winnerProvider).toBe(
        committed ? "provider" : undefined,
      );
      expect(state.finalizedAttempts).toEqual(committed ? ["candidate"] : []);
    },
  );

  it.each([
    ["yielded", "ok", { yielded: true, livenessState: "paused", stopReason: "end_turn" }],
    [
      "timed out",
      "timeout",
      {
        timeoutPhase: "provider",
        stopReason: "timeout",
        modelFallbackStopReason: "agent_run_terminal_timeout",
      },
    ],
    [
      "errored",
      "error",
      {
        error: { kind: "retry_limit", message: "provider failed" },
        stopReason: "error",
        modelFallbackStopReason: "idle_timeout_circuit_breaker",
      },
    ],
  ] as const)("does not finalize a %s candidate", async (_label, status, meta) => {
    usePrimaryFallback(async (params, result) => {
      if ("modelFallbackStopReason" in meta) {
        expect(await classify(params, result)).toEqual({
          stopReason: meta.modelFallbackStopReason,
        });
      }
    });
    const innerFailure = {
      provider: "inner-provider",
      model: "inner-model",
      ...sameModelRetry,
    };
    const result = await runEntry({
      selection: { cfg: {}, provider: "provider", model: "model" },
      runId: "settle-non-terminal",
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => true },
      runCandidate: async (provider, model, options) => {
        recordTurnAttempt(options.onContextEngineTurnCandidate, "candidate");
        return makeResult({
          provider,
          model,
          meta: {
            ...meta,
            executionTrace: {
              winnerProvider: provider,
              winnerModel: model,
              attempts: [innerFailure, { provider, model, result: "success" }],
              runner: "embedded",
            },
          },
        });
      },
    });

    expect(result.terminal.outcome.status).toBe(status);
    expect(result.result.meta.executionTrace).toMatchObject({
      winnerProvider: status === "ok" ? "provider" : undefined,
      winnerModel: status === "ok" ? "model" : undefined,
      attempts: [
        innerFailure,
        ...(status === "ok" ? [{ provider: "provider", model: "model", result: "success" }] : []),
      ],
    });
    expect(state.finalizedAttempts).toEqual([]);
  });

  it("retains non-visible follow-up results for terminal delivery", async () => {
    usePrimaryFallback(async (params, result) => {
      expect(await classify(params, result, 1)).toMatchObject({
        code: "empty_result",
        preserveResultOnExhaustion: true,
        preserveResultPriority: -1,
      });
    }, "exhausted");
    const result = await runEntry({
      runId: "followup",
      behavior: { kind: "followup-delivery" },
      runCandidate: async (provider, model) =>
        makeResult({ provider, model, classification: "empty" }),
    });

    expect(result.outcome).toBe("exhausted");
    expect(result.result.payloads).toEqual([]);
  });

  it("honors a configured response-model equivalent when preparing terminal metadata", async () => {
    const runId = "declared-endpoint";
    const route = { provider: "broker", model: "team/chat" };
    const reply = { disposition: "visible" as const, text: "done" };
    const broker = {
      baseUrl: "https://broker.example/v1",
      models: [{ ...makeModel(route.model), responseModelEquivalent: true }],
    };
    usePrimaryFallback();
    const result = await runEntry({
      runId,
      selection: { cfg: { models: { providers: { broker } } }, ...route },
      runCandidate: async (provider, model) => {
        const candidate = makeResult({ provider, model, meta: { terminalReply: reply } });
        candidate.meta.agentMeta!.terminalReceipt = receiptFor(
          runId,
          provider,
          model,
          "upstream-model",
        );
        return candidate;
      },
    });
    expect(result.terminal.metadata.terminalReceipt).toMatchObject({
      effective: { ...route, responseModel: "upstream-model" },
      rerouted: false,
    });
    expect(result.terminal.metadata.terminalReply).toEqual(reply);
  });

  it("records the producer-owned terminal snapshot for a CLI delivered source reply", async () => {
    const runId = "terminal-CLI delivered source reply";
    const expected = { disposition: "silent" as const };
    usePrimaryFallback();
    const result = await runEntry({
      selection: { cfg: {}, provider: "provider", model: "model" },
      runId,
      runCandidate: async (provider, model) => {
        const candidate = makeResult({
          provider,
          model,
          meta: { finalAssistantRawText: "NO_REPLY", terminalReply: expected },
        });
        candidate.sourceReplyDelivered = true;
        candidate.meta.agentMeta!.sessionId = "native-cli-session";
        return candidate;
      },
    });

    expect(result.terminal.metadata.terminalReply).toEqual(expected);
    expect(result.terminal.metadata.terminalReceipt).toMatchObject({
      runId,
      terminalDisposition: "not-visible",
      sourceReplyDelivered: true,
      sessionId: "session-1",
      requested: { provider: "provider", model: "model" },
      successfulToolNames: ["message"],
    });
  });
});
