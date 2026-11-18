import { expect, it, vi, type Mock } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { runEmbeddedAgentEntry } from "./run-entry.test-harness.js";
import {
  createDirectHarness,
  makeResult,
  recordTurnAttempt,
  initialAttemptOptions,
  fallbackAttemptOptions,
  type FallbackRunnerParams,
} from "./run-entry.test-support.js";

type EntryParams = Parameters<typeof runEmbeddedAgentEntry>[0];
const fallback = { provider: "fallback-provider", model: "fallback-model" };
function runEntry(runCandidate: EntryParams["runCandidate"], overrides: Partial<EntryParams> = {}) {
  return runEmbeddedAgentEntry({
    selection: { cfg: {}, provider: "provider", model: "model" },
    identity: { runId: "settle-exhausted", agentId: "main", sessionId: "session-1" },
    harness: createDirectHarness(),
    behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
    sessionOverride: { kind: "preserve" },
    ...overrides,
    runCandidate,
  });
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
  setRuntimeConfigSnapshot({});
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

/** Failure scenarios share the parent suite's runtime mocks and per-case reset. */
export function registerRunEntryFailureTests(state: {
  runWithModelFallback: Mock;
  finalizedAttempts: string[];
}) {
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
          const result = await params.run(fallback.provider, fallback.model, {
            ...fallbackAttemptOptions(params, "server_error"),
            isFinalFallbackAttempt: false,
          });
          expect(
            await params.classifyResult?.({ result, ...fallback, attempt: 2, total: 3 }),
          ).toBeNull();
          expect(child.requesterTurnRunId).toBe(identity.runId);
          return { outcome: "completed", result, ...fallback, attempts: [] };
        });
        const run = runEntry(runCandidate, { preparedRunAdmission: admission, identity });
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
      runEntry(runCandidate, { preparedRunAdmission: admission, identity }),
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
        fallback.provider,
        fallback.model,
        fallbackAttemptOptions(params, "unknown"),
      );
      return {
        outcome: "exhausted" as const,
        result: params.mergeExhaustedResult?.({ latestResult, preferredResult }) ?? latestResult,
        ...fallback,
        attempts: [],
      };
    });
    const result = await runEntry(async (provider, model, options) => {
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
              runId: "settle-exhausted",
              sessionId: "session-1",
              turnId: provider,
              requested: { provider, model },
              effective: { provider, model, responseModel: model },
              successfulToolNames: [],
              rerouted: false,
              assistantTranscriptIdempotencyKey: `saved-${provider}`,
            },
          },
        },
      });
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
      runEntry(runCandidate, {
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
}
