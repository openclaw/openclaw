import { describe, expect, it, vi } from "vitest";
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
      const result = await runEmbeddedAgentEntry({
        selection: { cfg, provider: "primary-provider", model: "primary-model" },
        identity: {
          runId: "run-shared-fallback",
          agentId: "main",
          sessionId: "session-1",
        },
        harness: createDirectHarness(),
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
                      runId: "run-shared-fallback",
                      sessionId: "session-1",
                      turnId: "turn-1",
                      assistantTranscriptIdempotencyKey: "selected-saved-reply",
                      requested: { provider, model },
                      effective: { provider, model, responseModel: "producer-model" },
                      successfulToolNames: [],
                      rerouted: false,
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
    expect(channel.result.outcome).toBe("completed");
    expect(channel.result.provider).toBe("fallback-provider");
    expect(channel.result.model).toBe("fallback-model");
    expect(channel.result.attempts).toEqual(command.result.attempts);
    expect(channel.result.terminal).toEqual(command.result.terminal);
    expect(channel.result.result.meta.executionTrace).toEqual({
      winnerProvider: "fallback-provider",
      winnerModel: "fallback-model",
      attempts: [
        {
          provider: "primary-provider",
          model: "primary-model",
          result: "candidate_failed",
          reason: "format",
        },
        {
          provider: "fallback-provider",
          model: "fallback-model",
          result: "same_model_transient",
          reason: "rate_limit",
        },
        { provider: "fallback-provider", model: "fallback-model", result: "success" },
      ],
      fallbackUsed: true,
      runner: "embedded",
    });
    expect(channel.result.result.meta.agentMeta?.terminalReceipt).toMatchObject({
      requested: { provider: "primary-provider", model: "primary-model" },
      effective: {
        provider: "fallback-provider",
        model: "fallback-model",
        responseModel: "producer-model",
      },
      rerouted: true,
    });
    expect(channel.result.terminal.metadata.assistantTranscriptIdempotencyKey).toBe(
      "selected-saved-reply",
    );
    expect(channel.result.terminal.metadata.terminalReceipt).toMatchObject({
      requested: { provider: "primary-provider", model: "primary-model" },
      effective: {
        provider: "fallback-provider",
        model: "fallback-model",
        responseModel: "producer-model",
      },
      rerouted: true,
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
    expect(channel.reconciled).toEqual([
      { provider: "fallback-provider", model: "fallback-model" },
    ]);
  });

  it("preflights caller-resolved CLI hosts instead of the model harness", async () => {
    const resolveContextEngineHost = vi.fn((provider: string) => ({
      id: `cli:${provider}`,
      label: `CLI backend "${provider}"`,
      capabilities: [],
    }));

    await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
      identity: { runId: "cli-host-preflight", agentId: "main", sessionId: "session-1" },
      harness: {
        workspaceDir: "/tmp/workspace",
        preparation: { kind: "direct" },
        resolveRuntimeOverride: () => undefined,
        resolveContextEngineHost,
      },
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
      sessionOverride: { kind: "preserve" },
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

    await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
      identity: { runId: "lazy-plugin-preflight", agentId: "main", sessionId: "session-1" },
      harness: {
        workspaceDir: "/tmp/workspace",
        preparation: { kind: "direct" },
        resolveRuntimeOverride: (provider) => `${provider}-harness`,
      },
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
      sessionOverride: { kind: "preserve" },
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
      const result = await params.run(params.provider, params.model, initialAttemptOptions(params));
      return {
        outcome: "completed" as const,
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    const result = await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
      identity: { runId: "maintenance", agentId: "main", sessionId: "session-1" },
      harness: createDirectHarness(),
      behavior: { kind: "maintenance" },
      sessionOverride: { kind: "preserve" },
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
    await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
      identity: { runId: "settle-winner", agentId: "main", sessionId: "session-1" },
      harness: createDirectHarness(),
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
      sessionOverride: { kind: "preserve" },
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
      return {
        outcome: "completed" as const,
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "provider", model: "model" },
      identity: { runId: "settle-after-abort", agentId: "main", sessionId: "session-1" },
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
        return {
          outcome: "completed",
          result,
          provider: params.provider,
          model: params.model,
          attempts: [],
        };
      });
      const run = await runEmbeddedAgentEntry({
        selection: { cfg: {}, provider: "provider", model: "model" },
        identity: { runId: "settle-result", agentId: "main", sessionId: "session-1" },
        harness: createDirectHarness(),
        behavior: { kind: "command-rpc", hasCommittedSideEffect },
        sessionOverride: { kind: "preserve" },
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
      expect(state.discardedAttempts).toEqual(committed ? [] : ["candidate"]);
    },
  );

  it.each([
    {
      label: "yielded",
      status: "ok",
      meta: { yielded: true, livenessState: "paused" as const, stopReason: "end_turn" },
    },
    { label: "aborted", status: "error", meta: { aborted: true, stopReason: "error" } },
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
    { label: "blocked", status: "error", meta: { livenessState: "blocked" as const } },
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
      return { outcome: "completed" as const, result, provider, model, attempts: [] };
    });
    const innerFailure = {
      provider: "inner-provider",
      model: "inner-model",
      result: "same_model_transient" as const,
      reason: "rate_limit",
    };
    const result = await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "provider", model: "model" },
      identity: { runId: "settle-non-terminal", agentId: "main", sessionId: "session-1" },
      harness: createDirectHarness(),
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => true },
      sessionOverride: { kind: "preserve" },
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
    expect(state.discardedAttempts).toEqual(["candidate"]);
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
      return {
        outcome: "exhausted" as const,
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    const result = await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
      identity: { runId: "followup", agentId: "main", sessionId: "session-1" },
      harness: createDirectHarness(),
      behavior: { kind: "followup-delivery" },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model) =>
        makeResult({ provider, model, classification: "empty" }),
    });

    expect(result.outcome).toBe("exhausted");
    expect(result.result.payloads).toEqual([]);
  });

  it.each([
    {
      name: "embedded visible reply",
      meta: { finalAssistantVisibleText: "visible", finalAssistantRawText: "visible" },
      expected: { disposition: "visible", text: "visible" },
    },
    {
      name: "CLI delivered source reply",
      meta: { finalAssistantRawText: "NO_REPLY" },
      sourceReplyDelivered: true as const,
      expected: { disposition: "silent" },
    },
    {
      name: "final internal source reply after silence",
      meta: { finalAssistantRawText: "NO_REPLY" },
      sourceReplies: [{ text: "forward this reply", sourceReplyFinal: true }],
      expected: { disposition: "visible", text: "forward this reply" },
    },
    {
      name: "progress internal reply before final assistant text",
      meta: { finalAssistantVisibleText: "completed answer" },
      sourceReplies: [{ text: "working", sourceReplyFinal: false }],
      expected: { disposition: "visible", text: "completed answer" },
    },
    {
      name: "CLI exact silence",
      meta: { finalAssistantVisibleText: "NO_REPLY", finalAssistantRawText: "NO_REPLY" },
      expected: { disposition: "silent" },
    },
    {
      name: "CLI punctuation-wrapped silence",
      meta: { finalAssistantVisibleText: "NO_REPLY...", finalAssistantRawText: "NO_REPLY..." },
      expected: { disposition: "silent" },
    },
    {
      name: "normalized silence without raw text",
      meta: { finalAssistantVisibleText: "no_reply" },
      expected: { disposition: "silent" },
    },
    {
      name: "clean empty reply",
      meta: {},
      expected: { disposition: "empty" },
    },
  ])(
    "records the producer-owned terminal snapshot for $name",
    async ({ name, meta, expected, sourceReplies, sourceReplyDelivered }) => {
      const runId = `terminal-${name}`;
      state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
        outcome: "completed" as const,
        result: await params.run(params.provider, params.model, initialAttemptOptions(params)),
        provider: params.provider,
        model: params.model,
        attempts: [],
      }));
      const result = await runEmbeddedAgentEntry({
        selection: { cfg: {}, provider: "provider", model: "model" },
        identity: { runId, agentId: "main", sessionId: "session-1" },
        harness: createDirectHarness(),
        behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
        sessionOverride: { kind: "preserve" },
        runCandidate: async (provider, model) => ({
          ...makeResult({ provider, model }),
          messagingToolSourceReplyPayloads: sourceReplies,
          sourceReplyDelivered,
          meta: {
            ...makeResult({ provider, model }).meta,
            ...meta,
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
                      runId,
                      sessionId: "session-1",
                      turnId: "turn-1",
                      requested: { provider, model },
                      effective: { provider, model, responseModel: model },
                      successfulToolNames: ["read"],
                      rerouted: false,
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
