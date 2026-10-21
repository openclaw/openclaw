import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeConfig from "../../config/runtime-snapshot.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as runRegistry from "../../infra/agent-run-registry.js";
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

beforeEach(() => runtimeConfig.setRuntimeConfigSnapshot({}));
afterEach(runtimeConfig.clearRuntimeConfigSnapshot);

type EntryParams = Parameters<typeof runEmbeddedAgentEntry>[0];
const primaryRoute = { provider: "primary-provider", model: "primary-model" };
const fallbackRoute = { provider: "fallback-provider", model: "fallback-model" };
const sameModelRetry = { result: "same_model_transient" as const, reason: "rate_limit" };
const identity = { agentId: "main", sessionId: "session-1" };
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
    identity: { runId, ...identity },
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

describe("runEmbeddedAgentEntry", () => {
  registerRunEntryFailureTests(state);

  it("keeps shared fallback and terminal behavior aligned across entry modes", async ({
    onTestFinished,
  }) => {
    const runMode = async (behavior: "channel-delivery" | "command-rpc") => {
      runRegistry.registerAgentRunContext("run-shared-fallback", {
        ...identity,
        sessionKey: "agent:main:chat",
      });
      onTestFinished(() => runRegistry.clearAgentRunContext("run-shared-fallback"));
      const candidateCalls: Array<typeof primaryRoute & { isFallbackRetry: boolean }> = [];
      const candidateLeases: object[] = [];
      const reconciled: Array<typeof primaryRoute> = [];
      const result = await runEntry({
        runId: "run-shared-fallback",
        behavior: behavior === "channel-delivery" ? channelDelivery : commandRpc,
        sessionOverride: {
          kind: "reconcile-completed",
          reconcile: async (candidate) => {
            reconciled.push(candidate);
          },
        },
        runCandidate: async (provider, model, options) => {
          expect(runRegistry.resolveProjectedAgentRunModel(identity)).toBeNull();
          runRegistry.recordAgentRunModel("run-shared-fallback", { provider, model });
          candidateCalls.push({ provider, model, isFallbackRetry: options.isFallbackRetry });
          candidateLeases.push(options.contextEngineLogicalTurnLease);
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

  it("finalizes only the accepted fallback candidate after its attempt releases ownership", async () => {
    const released: string[] = [];
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
        released.push(label);
        return makeResult({
          provider,
          model,
          classification: label === "primary" ? "empty" : undefined,
        });
      },
    });

    expect(released).toEqual(["primary", "fallback"]);
    expect(onAcceptedTerminal).toHaveBeenCalledOnce();
    expect(releaseAcceptedTerminalWork).toHaveBeenCalledOnce();
    expect(state.finalizedAttempts).toEqual(["fallback"]);
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

  it.each([true, false])(
    "announces an endpoint-resolved model unless its row declares it (declared: %s)",
    async (declared) => {
      const runId = `endpoint-resolved-${declared}`;
      const modelRow: ModelDefinitionConfig = {
        id: "team/chat",
        name: "Team chat",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
        ...(declared ? { responseModelEquivalent: true } : {}),
      };
      const broker = { baseUrl: "https://broker.example/v1", models: [modelRow] };
      const cfg: OpenClawConfig = { models: { providers: { broker } } };
      usePrimaryFallback();
      const result = await runEntry({
        selection: { cfg, provider: "broker", model: "team/chat" },
        runId,
        runCandidate: async (provider, model) => {
          const candidate = makeResult({
            provider,
            model,
            meta: {
              finalAssistantVisibleText: "done",
              finalAssistantRawText: "done",
              terminalReply: { disposition: "visible", text: "done" },
            },
          });
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
        effective: { provider: "broker", model: "team/chat", responseModel: "upstream-model" },
        rerouted: !declared,
      });
      expect(result.terminal.metadata.terminalReply).toEqual({
        disposition: "visible",
        text: "done",
        ...(declared
          ? {}
          : { modelRouteChange: "Model route changed: broker/team/chat → broker/upstream-model." }),
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
      usePrimaryFallback();
      const result = await runEntry({
        selection: { cfg: {}, provider: "provider", model: "model" },
        runId,
        runCandidate: async (provider, model) => {
          const candidate = makeResult({
            provider,
            model,
            meta: { ...meta, terminalReply: expected },
          });
          candidate.messagingToolSourceReplyPayloads = sourceReplies;
          candidate.sourceReplyDelivered = sourceReplyDelivered;
          if (sourceReplyDelivered) {
            candidate.meta.agentMeta!.sessionId = "native-cli-session";
          } else {
            candidate.meta.agentMeta!.terminalReceipt = {
              ...receiptFor(runId, provider, model),
              successfulToolNames: ["read"],
            };
          }
          return candidate;
        },
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
