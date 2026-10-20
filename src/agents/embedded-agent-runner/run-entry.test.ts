import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  recordAgentRunModel,
  resolveProjectedAgentRunModel,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { registerRunEntryFailureTests } from "./run-entry.failures.test-support.js";
import { runEmbeddedAgentEntry, setupRunEntryTestState } from "./run-entry.test-harness.js";
import {
  createDirectHarness,
  makeResult,
  recordTurnAttempt,
  initialAttemptOptions,
  type FallbackRunnerParams,
} from "./run-entry.test-support.js";

const state = setupRunEntryTestState();

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

type EntryParams = Parameters<typeof runEmbeddedAgentEntry>[0];
const primaryRoute = { provider: "primary-provider", model: "primary-model" };
const fallbackRoute = { provider: "fallback-provider", model: "fallback-model" };

function runEntry({
  runId = "run-entry",
  ...params
}: Pick<EntryParams, "runCandidate"> & Partial<EntryParams> & { runId?: string }) {
  return runEmbeddedAgentEntry({
    selection: { cfg: {}, ...primaryRoute },
    identity: { runId, agentId: "main", sessionId: "session-1" },
    harness: createDirectHarness(),
    behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
    sessionOverride: { kind: "preserve" },
    ...params,
  });
}

function completedFallback(
  params: FallbackRunnerParams,
  result: Awaited<ReturnType<FallbackRunnerParams["run"]>>,
  outcome: "completed" | "exhausted" = "completed",
) {
  return { outcome, result, provider: params.provider, model: params.model, attempts: [] };
}

async function runPrimary(params: FallbackRunnerParams) {
  return completedFallback(
    params,
    await params.run(params.provider, params.model, initialAttemptOptions(params)),
  );
}

function terminalReceipt(runId: string, provider: string, model: string, responseModel = model) {
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

describe("runEmbeddedAgentEntry", () => {
  registerRunEntryFailureTests(state);

  it("keeps shared fallback and terminal behavior aligned across entry modes", async ({
    onTestFinished,
  }) => {
    const cfg: OpenClawConfig = {};
    const runMode = async (behavior: "channel-delivery" | "command-rpc") => {
      registerAgentRunContext("run-shared-fallback", {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:chat",
      });
      onTestFinished(() => clearAgentRunContext("run-shared-fallback"));
      const candidateCalls: Array<{
        provider: string;
        model: string;
        isFallbackRetry: boolean;
      }> = [];
      const candidateLeases: object[] = [];
      const reconciled: Array<{ provider: string; model: string }> = [];
      const result = await runEntry({
        selection: { cfg, ...primaryRoute },
        identity: {
          runId: "run-shared-fallback",
          agentId: "main",
          sessionId: "session-1",
        },
        behavior:
          behavior === "channel-delivery"
            ? {
                kind: "channel-delivery" as const,
                readDeliveryEvidence: () => ({
                  hasDirectlySentBlockReply: false,
                  hasBlockReplyPipelineOutput: false,
                  hasRetryBlockedDelivery: false,
                }),
              }
            : {
                kind: "command-rpc" as const,
                hasCommittedSideEffect: () => false,
              },
        sessionOverride: {
          kind: "reconcile-completed",
          reconcile: async (candidate) => {
            reconciled.push(candidate);
          },
        },
        runCandidate: async (provider, model, options) => {
          expect(
            resolveProjectedAgentRunModel({
              agentId: "main",
              sessionId: "session-1",
            }),
          ).toBeNull();
          recordAgentRunModel("run-shared-fallback", { provider, model });
          candidateCalls.push({ provider, model, isFallbackRetry: options.isFallbackRetry });
          candidateLeases.push(options.contextEngineLogicalTurnLease);
          return makeResult({
            provider,
            model,
            classification: options.isFallbackRetry ? undefined : "empty",
            meta: options.isFallbackRetry
              ? {
                  finalAssistantVisibleText: "fallback complete",
                  finalAssistantRawText: "fallback complete",
                  terminalReply: { disposition: "visible", text: "fallback complete" },
                  executionTrace: {
                    winnerProvider: provider,
                    winnerModel: model,
                    attempts: [
                      {
                        provider,
                        model,
                        result: "same_model_transient",
                        reason: "rate_limit",
                      },
                      { provider, model, result: "success" },
                    ],
                    fallbackUsed: false,
                    runner: "embedded",
                  },
                  agentMeta: {
                    sessionId: "session-1",
                    provider,
                    model,
                    terminalReceipt: {
                      ...terminalReceipt("run-shared-fallback", provider, model, "producer-model"),
                      assistantTranscriptIdempotencyKey: "selected-saved-reply",
                    },
                  },
                }
              : undefined,
          });
        },
      });
      expect(getAgentRunContext("run-shared-fallback")?.activeModel).toBeUndefined();
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
        {
          ...fallbackRoute,
          result: "same_model_transient",
          reason: "rate_limit",
        },
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
    expect(channel.result.terminal.metadata.assistantTranscriptIdempotencyKey).toBe(
      "selected-saved-reply",
    );
    expect(channel.result.terminal.metadata.terminalReceipt).toMatchObject({
      ...expectedReceipt,
      terminalDisposition: "visible",
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
        workspaceDir: "/tmp/workspace",
        preparation: { kind: "direct" },
        resolveRuntimeOverride: () => undefined,
        resolveContextEngineHost,
      },
      runCandidate: async (provider, model) =>
        makeResult({
          provider,
          model,
          classification: provider === "primary-provider" ? "empty" : undefined,
        }),
    });

    expect(resolveContextEngineHost).toHaveBeenCalledWith(
      "primary-provider",
      "primary-model",
      undefined,
    );
    expect(resolveContextEngineHost).toHaveBeenCalledWith(
      "fallback-provider",
      "fallback-model",
      undefined,
    );
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
        workspaceDir: "/tmp/workspace",
        preparation: { kind: "direct" },
        resolveRuntimeOverride: (provider) => `${provider}-harness`,
      },
      runCandidate: async (provider, model) =>
        makeResult({
          provider,
          model,
          classification: provider === "primary-provider" ? "empty" : undefined,
        }),
    });

    expect(events).toEqual([
      "ensure:primary-provider",
      "select:primary-provider",
      "ensure:fallback-provider",
      "select:fallback-provider",
    ]);
  });

  it("leaves maintenance fallback classification to thrown candidate errors", async () => {
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      expect(params.classifyResult).toBeUndefined();
      expect(params.mergeExhaustedResult).toBeUndefined();
      return runPrimary(params);
    });
    const result = await runEntry({
      runId: "maintenance",
      behavior: { kind: "maintenance" },
      runCandidate: async (provider, model) => makeResult({ provider, model }),
    });

    expect(result.result.payloads).toEqual([{ text: "recovered" }]);
  });

  it("finalizes only the accepted fallback candidate after its attempt releases ownership", async () => {
    let primaryReleased = false;
    let fallbackReleased = false;
    const releaseAcceptedTerminalWork = vi.fn();
    const onAcceptedTerminal = vi.fn(() => {
      expect(state.finalizedAttempts).toEqual([]);
      return releaseAcceptedTerminalWork;
    });
    await runEntry({
      runId: "settle-winner",
      onAcceptedTerminal,
      runCandidate: async (provider, model, options) => {
        const label = provider === "primary-provider" ? "primary" : "fallback";
        recordTurnAttempt(options.onContextEngineTurnCandidate, label);
        if (label === "primary") {
          primaryReleased = true;
        } else {
          fallbackReleased = true;
        }
        return makeResult({
          provider,
          model,
          classification: label === "primary" ? "empty" : undefined,
        });
      },
    });

    expect(primaryReleased).toBe(true);
    expect(fallbackReleased).toBe(true);
    expect(onAcceptedTerminal).toHaveBeenCalledOnce();
    expect(releaseAcceptedTerminalWork).toHaveBeenCalledOnce();
    expect(state.finalizedAttempts).toEqual(["fallback"]);
  });

  it("does not commit the accepted terminal after abort wins before fallback settlement", async () => {
    const abortController = new AbortController();
    const onAcceptedTerminal = vi.fn();
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run(params.provider, params.model, initialAttemptOptions(params));
      abortController.abort("user_abort");
      return completedFallback(params, result);
    });
    await runEntry({
      selection: { cfg: {}, provider: "provider", model: "model" },
      identity: { runId: "settle-after-abort", agentId: "main", sessionId: "session-1" },
      behavior: {
        kind: "channel-delivery",
        readDeliveryEvidence: () => ({
          hasDirectlySentBlockReply: false,
          hasBlockReplyPipelineOutput: false,
          hasRetryBlockedDelivery: false,
        }),
      },
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
      const hasCommittedSideEffect = vi.fn(() => committed);
      state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
        const result = await params.run(
          params.provider,
          params.model,
          initialAttemptOptions(params),
        );
        const classification = await params.classifyResult?.({
          result,
          provider: params.provider,
          model: params.model,
          attempt: 1,
          total: 2,
        });
        expect(classification).toBe(committed ? undefined : null);
        return completedFallback(params, result);
      });
      const run = await runEntry({
        selection: { cfg: {}, provider: "provider", model: "model" },
        identity: { runId: "settle-result", agentId: "main", sessionId: "session-1" },
        behavior: { kind: "command-rpc", hasCommittedSideEffect },
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
    {
      label: "yielded",
      status: "ok",
      meta: { yielded: true, livenessState: "paused" as const, stopReason: "end_turn" },
    },
    {
      label: "timed out",
      status: "timeout",
      meta: {
        timeoutPhase: "provider" as const,
        stopReason: "timeout",
        modelFallbackStopReason: "agent_run_terminal_timeout" as const,
      },
    },
    {
      label: "errored",
      status: "error",
      meta: {
        error: { kind: "retry_limit" as const, message: "provider failed" },
        stopReason: "error",
        modelFallbackStopReason: "idle_timeout_circuit_breaker" as const,
      },
    },
  ])("does not finalize a $label candidate", async ({ meta, status }) => {
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const { provider, model } = params;
      const result = await params.run(provider, model, initialAttemptOptions(params));
      if ("modelFallbackStopReason" in meta) {
        const classification = await params.classifyResult?.({
          result,
          provider,
          model,
          attempt: 1,
          total: 2,
        });
        expect(classification).toEqual({ stopReason: meta.modelFallbackStopReason });
      }
      return completedFallback(params, result);
    });
    const innerFailure = {
      provider: "inner-provider",
      model: "inner-model",
      result: "same_model_transient" as const,
      reason: "rate_limit",
    };
    const result = await runEntry({
      selection: { cfg: {}, provider: "provider", model: "model" },
      identity: { runId: "settle-non-terminal", agentId: "main", sessionId: "session-1" },
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
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run(params.provider, params.model, initialAttemptOptions(params));
      expect(
        params.classifyResult?.({
          result,
          provider: params.provider,
          model: params.model,
          attempt: 1,
          total: 1,
        }),
      ).toMatchObject({
        code: "empty_result",
        preserveResultOnExhaustion: true,
        preserveResultPriority: -1,
      });
      return completedFallback(params, result, "exhausted");
    });
    const result = await runEntry({
      runId: "followup",
      behavior: { kind: "followup-delivery" },
      runCandidate: async (provider, model) =>
        makeResult({ provider, model, classification: "empty" }),
    });

    expect(result.outcome).toBe("exhausted");
    expect(result.result.payloads).toEqual([]);
  });

  it.each([
    { declared: true, modelRouteChange: undefined },
    {
      declared: false,
      modelRouteChange: "Model route changed: broker/team/chat → broker/upstream-model.",
    },
  ])(
    "announces an endpoint-resolved response model unless its configured row declares it (declared: $declared)",
    async ({ declared, modelRouteChange }) => {
      const runId = `endpoint-resolved-${declared}`;
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            broker: {
              baseUrl: "https://broker.example/v1",
              models: [
                {
                  id: "team/chat",
                  name: "Team chat",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 8_192,
                  ...(declared ? { responseModelEquivalent: true } : {}),
                },
              ],
            },
          },
        },
      };
      state.runWithModelFallback.mockImplementationOnce(runPrimary);
      const result = await runEntry({
        selection: { cfg, provider: "broker", model: "team/chat" },
        identity: { runId, agentId: "main", sessionId: "session-1" },
        runCandidate: async (provider, model) =>
          makeResult({
            provider,
            model,
            meta: {
              finalAssistantVisibleText: "done",
              finalAssistantRawText: "done",
              terminalReply: { disposition: "visible", text: "done" },
              agentMeta: {
                sessionId: "session-1",
                provider,
                model,
                terminalReceipt: terminalReceipt(runId, provider, model, "upstream-model"),
              },
            },
          }),
      });

      expect(result.terminal.metadata.terminalReceipt).toMatchObject({
        effective: { provider: "broker", model: "team/chat", responseModel: "upstream-model" },
        rerouted: !declared,
      });
      expect(result.terminal.metadata.terminalReply).toEqual({
        disposition: "visible",
        text: "done",
        ...(modelRouteChange ? { modelRouteChange } : {}),
      });
    },
  );

  it.each([
    {
      name: "CLI delivered source reply",
      meta: { finalAssistantRawText: "NO_REPLY" },
      sourceReplyDelivered: true as const,
      expected: { disposition: "silent" as const },
    },
    {
      name: "final internal source reply after silence",
      meta: { finalAssistantRawText: "NO_REPLY" },
      sourceReplies: [{ text: "forward this reply", sourceReplyFinal: true }],
      expected: { disposition: "visible" as const, text: "forward this reply" },
    },
    {
      name: "prepared visible literal NO_REPLY",
      meta: { finalAssistantRawText: "NO_REPLY\nNO_REPLY" },
      sourceReplies: [{ text: "NO_REPLY", sourceReplyFinal: true }],
      expected: { disposition: "visible" as const, text: "NO_REPLY" },
    },
  ])(
    "records the producer-owned terminal snapshot for $name",
    async ({ name, meta, expected, sourceReplies, sourceReplyDelivered }) => {
      const runId = `terminal-${name}`;
      state.runWithModelFallback.mockImplementationOnce(runPrimary);
      const result = await runEntry({
        selection: { cfg: {}, provider: "provider", model: "model" },
        identity: { runId, agentId: "main", sessionId: "session-1" },
        runCandidate: async (provider, model) => ({
          ...makeResult({ provider, model }),
          messagingToolSourceReplyPayloads: sourceReplies,
          sourceReplyDelivered,
          meta: {
            ...makeResult({ provider, model }).meta,
            ...meta,
            terminalReply: expected,
            agentMeta: Object.assign(
              {
                sessionId: sourceReplyDelivered ? "native-cli-session" : "session-1",
                provider,
                model,
              },
              sourceReplyDelivered
                ? {}
                : {
                    terminalReceipt: {
                      ...terminalReceipt(runId, provider, model),
                      successfulToolNames: ["read"],
                    },
                  },
            ),
          },
        }),
      });

      expect(result.terminal.metadata.terminalReply).toEqual(expected);
      expect(result.terminal.metadata.terminalReceipt).toMatchObject({
        runId,
        terminalDisposition: expected.disposition === "visible" ? "visible" : "not-visible",
      });
      if (sourceReplyDelivered) {
        expect(result.terminal.metadata.terminalReceipt).toMatchObject({
          sourceReplyDelivered: true,
          sessionId: "session-1",
          requested: { provider: "provider", model: "model" },
          successfulToolNames: ["message"],
        });
      }
    },
  );
});
