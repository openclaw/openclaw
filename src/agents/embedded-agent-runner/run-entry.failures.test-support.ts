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
  discardedAttempts: string[];
}) {
  it.each([
    { runtime: "cli", retained: true, revokeAtCleanup: false, errorResult: false },
    { runtime: "embedded", retained: true, revokeAtCleanup: false, errorResult: false },
    { runtime: "embedded", retained: true, revokeAtCleanup: false, errorResult: true },
    { runtime: "cli", retained: false, revokeAtCleanup: false, errorResult: false },
    { runtime: "cli", retained: true, revokeAtCleanup: true, errorResult: false },
  ] as const)(
    "classifies retained children before candidate acceptance ($runtime, retained=$retained, revoked=$revokeAtCleanup, error=$errorResult)",
    async ({ runtime, retained, revokeAtCleanup, errorResult }) => {
      const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
      const { prepareSystemAgentRunAdmission } = await import("../admitted-run-context.js");
      const { mergeAcceptedSessionSpawnsForRun } = await import("../accepted-session-spawn.js");
      const { createSubagentRunRecord } = await import("../subagent-test-fixtures.test-helpers.js");
      const { subagentRuns } = await import("../subagents/registry/subagent-registry-memory.js");
      const { saveSubagentRegistryChangesToSqlite, loadSubagentRunsByRunIdsFromSqlite } =
        await import("../subagents/registry/subagent-registry.store.sqlite.js");
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
        if (retained) {
          subagentRuns.set(child.runId, child);
          saveSubagentRegistryChangesToSqlite(subagentRuns, [child.runId]);
        }
        await admission.admit("embedded");
        const runCandidate = vi.fn(
          async (
            provider: string,
            model: string,
            options: Parameters<Parameters<typeof runEmbeddedAgentEntry>[0]["runCandidate"]>[2],
          ) => {
            if (!options.isFallbackRetry) {
              mergeAcceptedSessionSpawnsForRun(
                admission.operationalRunInstance,
                retained
                  ? [
                      {
                        runId: child.runId,
                        childSessionKey: child.childSessionKey,
                        expectsCompletionMessage: true,
                      },
                    ]
                  : [],
              );
              throw error;
            }
            if (provider === "winner-provider") {
              return makeResult({ provider, model });
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
                expect(options.classifyResult(candidate)).toEqual(
                  retained ? null : expect.objectContaining({ code: "empty_result" }),
                );
                expect(child.requesterTurnRunId).toBe(identity.runId);
                return candidate;
              },
              { preparedRunAdmission: admission, isFinalFallbackAttempt: false },
            );
            placementReleased = true;
            expect(child.requesterTurnRunId).toBe(identity.runId);
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
          expect(classification).toEqual(
            retained ? null : expect.objectContaining({ code: "empty_result" }),
          );
          expect(child.requesterTurnRunId).toBe(identity.runId);
          const winner = retained
            ? result
            : await params.run("winner-provider", "winner-model", {
                ...fallbackAttemptOptions(params, "format"),
                isFinalFallbackAttempt: true,
              });
          return {
            outcome: "completed",
            result: winner,
            provider: retained ? "fallback-provider" : "winner-provider",
            model: retained ? "fallback-model" : "winner-model",
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
          expect(loadSubagentRunsByRunIdsFromSqlite([child.runId])[0]).toMatchObject({
            requesterTurnRunId: identity.runId,
          });
          return;
        }
        const result = await run;
        expect(placementReleased).toBe(true);
        expect(runCandidate).toHaveBeenCalledTimes(retained ? 2 : 3);
        if (retained) {
          expect(result.result.acceptedSessionSpawns).toHaveLength(1);
          expect(loadSubagentRunsByRunIdsFromSqlite([child.runId])[0]).toMatchObject({
            runId: child.runId,
            requesterTurnRunId: undefined,
          });
        } else {
          expect(result.result.acceptedSessionSpawns).toBeUndefined();
        }
      } finally {
        restoreCleanup?.();
        subagentRuns.delete(child.runId);
        admission.close();
        await fixture.cleanup();
      }
    },
  );

  it.each([false, true])(
    "settles terminal failure after all runnable candidates fail (later candidates skipped=%s)",
    async (skipRemaining) => {
      const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
      const { prepareSystemAgentRunAdmission } = await import("../admitted-run-context.js");
      const { mergeAcceptedSessionSpawnsForRun } = await import("../accepted-session-spawn.js");
      const { createSubagentRunRecord } = await import("../subagent-test-fixtures.test-helpers.js");
      const { subagentRuns } = await import("../subagents/registry/subagent-registry-memory.js");
      const { saveSubagentRegistryChangesToSqlite, loadSubagentRunsByRunIdsFromSqlite } =
        await import("../subagents/registry/subagent-registry.store.sqlite.js");
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
          expect(loadSubagentRunsByRunIdsFromSqlite([child.runId])[0]?.requesterTurnRunId).toBe(
            identity.runId,
          );
          if (!skipRemaining) {
            await expect(
              params.run("fallback-provider", "fallback-model", {
                ...fallbackAttemptOptions(params, "server_error"),
                isFinalFallbackAttempt: true,
              }),
            ).rejects.toBe(providerError);
            expect(child.requesterTurnRunId).toBe(identity.runId);
          }
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
        expect(runCandidate).toHaveBeenCalledTimes(skipRemaining ? 1 : 2);
        expect(child.requesterTurnRunId).toBeUndefined();
        expect(loadSubagentRunsByRunIdsFromSqlite([child.runId])[0]).toMatchObject({
          runId: child.runId,
          requesterTurnRunId: undefined,
        });
      } finally {
        subagentRuns.delete(child.runId);
        admission.close();
        await fixture.cleanup();
      }
    },
  );

  it("does not persist a previous candidate error after fallback setup fails", async () => {
    const transcript = await import("../../config/sessions/transcript.js");
    const { makeAssistantMessageFixture } =
      await import("../test-helpers/assistant-message-fixtures.js");
    const append = vi
      .spyOn(transcript, "appendExactAssistantMessageToSessionTranscript")
      .mockRejectedValue(new Error("stale error committed"));
    try {
      await expect(
        runEmbeddedAgentEntry({
          selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
          identity: { runId: "run-stale-error", agentId: "main", sessionId: "session-1" },
          harness: createDirectHarness(),
          behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
          sessionOverride: { kind: "preserve" },
          runCandidate: async (provider, model, options) => {
            if (options.isFallbackRetry) {
              throw new Error("fallback setup failed");
            }
            options.assistantErrorTranscript.record(
              makeAssistantMessageFixture({ provider, model }),
              {
                agentId: "main",
                sessionId: "session-1",
                sessionKey: "agent:main:session-1",
                storePath: "/tmp/unused-stale-error.sqlite",
              },
            );
            return makeResult({ provider, model, classification: "empty" });
          },
        }),
      ).rejects.toThrow("fallback setup failed");
      expect(append).not.toHaveBeenCalled();
    } finally {
      append.mockRestore();
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
    expect(state.discardedAttempts).toEqual(["fallback-provider"]);
  });

  it("does not finalize a candidate when classification throws", async () => {
    const classificationError = new Error("classification failed");
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run(params.provider, params.model, initialAttemptOptions(params));
      await params.classifyResult?.({
        result,
        provider: params.provider,
        model: params.model,
        attempt: 1,
        total: 1,
      });
      throw classificationError;
    });
    await expect(
      runEmbeddedAgentEntry({
        selection: { cfg: {}, provider: "provider", model: "model" },
        identity: { runId: "settle-classifier-throw", agentId: "main", sessionId: "session-1" },
        harness: createDirectHarness(),
        behavior: {
          kind: "channel-delivery",
          readDeliveryEvidence: () => {
            throw classificationError;
          },
        },
        sessionOverride: { kind: "preserve" },
        runCandidate: async (provider, model, options) => {
          recordTurnAttempt(options.onContextEngineTurnCandidate, "candidate");
          return makeResult({ provider, model, classification: "empty" });
        },
      }),
    ).rejects.toBe(classificationError);

    expect(state.finalizedAttempts).toEqual([]);
    expect(state.discardedAttempts).toEqual(["candidate"]);
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
    const runCandidate = vi.fn(async (_provider: string, _model: string) => {
      throw failure;
    });

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
  });

  it("still falls back when a thrown channel-delivery attempt delivered nothing", async () => {
    const failure = new Error("insufficient quota");
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
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
      expect(allowed).toBe(true);
      const fallbackProvider = "fallback-provider";
      const fallbackModel = "fallback-model";
      const result = await params.run(fallbackProvider, fallbackModel, {
        ...fallbackAttemptOptions(params, "billing"),
        isFinalFallbackAttempt: true,
      });
      return {
        outcome: "completed" as const,
        result,
        provider: fallbackProvider,
        model: fallbackModel,
        attempts: [
          {
            provider: params.provider,
            model: params.model,
            error: failure.message,
            reason: "billing" as const,
          },
        ],
      };
    });
    const runCandidate = vi.fn(async (provider: string, model: string) => {
      if (provider === "primary-provider") {
        throw failure;
      }
      return makeResult({ provider, model });
    });

    const result = await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
      identity: { runId: "channel-throw-empty", agentId: "main", sessionId: "session-1" },
      harness: createDirectHarness(),
      behavior: {
        kind: "channel-delivery",
        readDeliveryEvidence: () => ({
          hasDirectlySentBlockReply: false,
          hasBlockReplyPipelineOutput: false,
          hasRetryBlockedDelivery: false,
        }),
      },
      sessionOverride: { kind: "preserve" },
      runCandidate,
    });

    expect(runCandidate).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe("completed");
    expect(result.provider).toBe("fallback-provider");
  });
}
