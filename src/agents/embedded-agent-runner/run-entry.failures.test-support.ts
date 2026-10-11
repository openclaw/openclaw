import { expect, it, vi, type Mock } from "vitest";
import { runEmbeddedAgentEntry } from "./run-entry.test-harness.js";
import {
  createDirectHarness,
  makeResult,
  recordTurnAttempt,
  initialAttemptOptions,
  fallbackAttemptOptions,
  type FallbackRunnerParams,
} from "./run-entry.test-support.js";

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
      const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
      const { prepareSystemAgentRunAdmission } = await import("../admitted-run-context.js");
      const { mergeAcceptedSessionSpawnsForRun } = await import("../accepted-session-spawn.js");
      const { createSubagentRunRecord } = await import("../subagent-test-fixtures.test-helpers.js");
      const { subagentRuns } = await import("../subagents/registry/subagent-registry-memory.js");
      const { saveSubagentRegistryChangesToSqlite, loadSubagentRegistryFromSqlite } =
        await import("../subagents/registry/subagent-registry-state.fixture.test-support.js");
      const { withLocalSessionPlacementTurnSettlement } =
        await import("../session-placement-admission.js");
      const fixture = await createOpenClawTestState({ label: "entry-cli-acceptance" });
      const identity = {
        runId: "retained-parent",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      };
      const admission = prepareSystemAgentRunAdmission(
        {},
        identity.runId,
        "main",
        "entry-cli-test",
      );
      const child = createSubagentRunRecord({
        runId: "retained-child",
        requesterSessionKey: identity.sessionKey,
        requesterAgentId: identity.agentId,
        requesterTurnRunId: identity.runId,
        expectsCompletionMessage: true,
        completion: { required: true },
        delivery: { status: "pending" },
      });
      const error = new Error("first provider failed after spawning");
      let placementReleased = false;
      let restoreCleanup: (() => void) | undefined;
      try {
        subagentRuns.set(child.runId, child);
        saveSubagentRegistryChangesToSqlite(subagentRuns, [child.runId]);
        await admission.admit("embedded");
        const runCandidate = vi.fn(
          async (
            provider: string,
            model: string,
            options: Parameters<Parameters<typeof runEmbeddedAgentEntry>[0]["runCandidate"]>[2],
          ) => {
            if (!options.isFallbackRetry) {
              mergeAcceptedSessionSpawnsForRun(admission.operationalRunInstance, [
                {
                  runId: child.runId,
                  childSessionKey: child.childSessionKey,
                  expectsCompletionMessage: true,
                },
              ]);
              throw error;
            }
            if (revokeAtCleanup) {
              const settle = options.assistantErrorTranscript.settle.bind(
                options.assistantErrorTranscript,
              );
              const spy = vi
                .spyOn(options.assistantErrorTranscript, "settle")
                .mockImplementation(async (...args) => {
                  await settle(...args);
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
                ...(errorResult
                  ? {
                      error: {
                        kind: "incomplete_turn" as const,
                        message: "candidate incomplete",
                        fallbackSafe: true,
                      },
                    }
                  : {}),
              },
            });
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
          const result = await params.run("fallback-provider", "fallback-model", {
            ...fallbackAttemptOptions(params, "server_error"),
            isFinalFallbackAttempt: false,
          });
          const classification = await params.classifyResult?.({
            result,
            provider: "fallback-provider",
            model: "fallback-model",
            attempt: 2,
            total: 3,
          });
          expect(classification).toBeNull();
          expect(child.requesterTurnRunId).toBe(identity.runId);
          return {
            outcome: "completed",
            result,
            provider: "fallback-provider",
            model: "fallback-model",
            attempts: [],
          };
        });
        const run = runEmbeddedAgentEntry({
          preparedRunAdmission: admission,
          selection: { cfg: {}, provider: "provider", model: "model" },
          identity,
          harness: createDirectHarness(),
          behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
          sessionOverride: { kind: "preserve" },
          runCandidate,
        });
        if (revokeAtCleanup) {
          await expect(run).rejects.toThrow("settlement is closed");
          expect(loadSubagentRegistryFromSqlite().get(child.runId)).toMatchObject({
            requesterTurnRunId: identity.runId,
          });
          return;
        }
        const result = await run;
        expect(placementReleased).toBe(true);
        expect(runCandidate).toHaveBeenCalledTimes(2);
        expect(result.result.acceptedSessionSpawns).toHaveLength(1);
        expect(loadSubagentRegistryFromSqlite().get(child.runId)).toMatchObject({
          runId: child.runId,
          requesterTurnRunId: undefined,
        });
      } finally {
        restoreCleanup?.();
        subagentRuns.delete(child.runId);
        admission.close();
        await fixture.cleanup();
      }
    },
  );

  it("settles terminal failure when later candidates are skipped", async () => {
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    const { prepareSystemAgentRunAdmission } = await import("../admitted-run-context.js");
    const { mergeAcceptedSessionSpawnsForRun } = await import("../accepted-session-spawn.js");
    const { createSubagentRunRecord } = await import("../subagent-test-fixtures.test-helpers.js");
    const { subagentRuns } = await import("../subagents/registry/subagent-registry-memory.js");
    const { saveSubagentRegistryChangesToSqlite, loadSubagentRegistryFromSqlite } =
      await import("../subagents/registry/subagent-registry-state.fixture.test-support.js");
    const fixture = await createOpenClawTestState({ label: "entry-failure-settlement" });
    const identity = {
      runId: "failed-entry",
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    };
    const admission = prepareSystemAgentRunAdmission(
      {},
      identity.runId,
      "main",
      "entry-failure-test",
    );
    const child = createSubagentRunRecord({
      runId: "entry-failure-child",
      requesterSessionKey: identity.sessionKey,
      requesterAgentId: identity.agentId,
      requesterTurnRunId: identity.runId,
      expectsCompletionMessage: true,
      completion: { required: true },
      delivery: { status: "pending" },
    });
    try {
      subagentRuns.set(child.runId, child);
      saveSubagentRegistryChangesToSqlite(subagentRuns, [child.runId]);
      await admission.admit("embedded");
      const providerError = new Error("provider failed");
      const exhausted = new Error("all candidates failed or were skipped");
      const runCandidate = vi.fn(async () => {
        mergeAcceptedSessionSpawnsForRun(admission.operationalRunInstance, [
          {
            runId: child.runId,
            childSessionKey: child.childSessionKey,
            expectsCompletionMessage: true,
          },
        ]);
        throw providerError;
      });
      state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
        await expect(
          params.run(params.provider, params.model, {
            ...initialAttemptOptions(params),
            isFinalFallbackAttempt: false,
          }),
        ).rejects.toBe(providerError);
        expect(loadSubagentRegistryFromSqlite().get(child.runId)?.requesterTurnRunId).toBe(
          identity.runId,
        );
        throw exhausted;
      });
      await expect(
        runEmbeddedAgentEntry({
          preparedRunAdmission: admission,
          selection: { cfg: {}, provider: "provider", model: "model" },
          identity,
          harness: createDirectHarness(),
          behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
          sessionOverride: { kind: "preserve" },
          runCandidate,
        }),
      ).rejects.toBe(exhausted);
      expect(runCandidate).toHaveBeenCalledOnce();
      expect(child.requesterTurnRunId).toBe(identity.runId);
      expect(subagentRuns.get(child.runId)).toMatchObject({
        runId: child.runId,
        requesterTurnRunId: undefined,
      });
      expect(loadSubagentRegistryFromSqlite().get(child.runId)).toMatchObject({
        runId: child.runId,
        requesterTurnRunId: undefined,
      });
    } finally {
      subagentRuns.delete(child.runId);
      admission.close();
      await fixture.cleanup();
    }
  });

  it("does not finalize any candidate when fallback is exhausted", async () => {
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const preferredResult = await params.run(
        params.provider,
        params.model,
        initialAttemptOptions(params),
      );
      const latestResult = await params.run(
        "fallback-provider",
        "fallback-model",
        fallbackAttemptOptions(params, "unknown"),
      );
      return {
        outcome: "exhausted" as const,
        result: params.mergeExhaustedResult?.({ latestResult, preferredResult }) ?? latestResult,
        provider: "fallback-provider",
        model: "fallback-model",
        attempts: [],
      };
    });
    const result = await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "provider", model: "model" },
      identity: { runId: "settle-exhausted", agentId: "main", sessionId: "session-1" },
      harness: createDirectHarness(),
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
      sessionOverride: { kind: "preserve" },
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
      // Mirror the fallback loop's thrown-error exit: the attempt error bypasses
      // result classification, so the error-path backstop is the only guard that
      // can stop the next candidate from replaying the delivered turn.
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
    const runCandidate = vi.fn(
      async (
        _provider: string,
        _model: string,
        options: Parameters<Parameters<typeof runEmbeddedAgentEntry>[0]["runCandidate"]>[2],
      ) => {
        recordTurnAttempt(options.onContextEngineTurnCandidate, "candidate");
        throw failure;
      },
    );

    await expect(
      runEmbeddedAgentEntry({
        selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
        identity: { runId: "channel-throw", agentId: "main", sessionId: "session-1" },
        harness: createDirectHarness(),
        behavior: {
          kind: "channel-delivery",
          readDeliveryEvidence: () => ({
            hasDirectlySentBlockReply: true,
            hasBlockReplyPipelineOutput: false,
            hasRetryBlockedDelivery: false,
          }),
        },
        sessionOverride: { kind: "preserve" },
        runCandidate,
      }),
    ).rejects.toBe(failure);

    expect(runCandidate).toHaveBeenCalledTimes(1);
    expect(state.finalizedAttempts).toEqual([]);
  });
}
