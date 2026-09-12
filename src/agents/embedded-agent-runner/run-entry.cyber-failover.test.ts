import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordModelFallbackStop } from "../failover-error.js";
import { resetFallbackSkipCacheForTest } from "../fallback-skip-cache.test-support.js";
import { runEmbeddedAgentEntry } from "./run-entry.js";
import { initialAttemptOptions, type FallbackRunnerParams } from "./run-entry.test-support.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const state = vi.hoisted(() => ({
  runWithModelFallback: vi.fn(),
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

function makeResult(params: {
  provider: string;
  model: string;
  meta?: Partial<EmbeddedAgentRunResult["meta"]>;
}): EmbeddedAgentRunResult {
  return {
    payloads: [{ text: "recovered" }],
    meta: {
      durationMs: 10,
      aborted: false,
      providerStarted: true,
      stopReason: "completed",
      agentMeta: {
        sessionId: "session-1",
        provider: params.provider,
        model: params.model,
      },
      ...params.meta,
    },
  };
}

function createDirectHarness() {
  return {
    workspaceDir: "/tmp/workspace",
    preparation: { kind: "direct" as const },
    resolveRuntimeOverride: () => undefined,
  };
}

describe("runEmbeddedAgentEntry cyber failover", () => {
  beforeEach(() => {
    resetFallbackSkipCacheForTest();
    state.runWithModelFallback.mockReset();
  });

  it("retries a replay-safe OpenAI cyber refusal once on Daybreak without changing selection", async () => {
    const candidateCalls: Array<{
      provider: string;
      model: string;
      isFallbackRetry: boolean;
      routingStage: string;
    }> = [];
    const reconciled: Array<{ provider: string; model: string }> = [];
    state.runWithModelFallback.mockImplementation(async (params: FallbackRunnerParams) => {
      const candidate = await params.run(
        params.provider,
        params.model,
        initialAttemptOptions(params),
      );
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
    });

    const result = await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "openai", model: "gpt-5.6" },
      identity: { runId: "run-cyber-escalation", agentId: "main", sessionId: "session-1" },
      harness: createDirectHarness(),
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
      sessionOverride: {
        kind: "reconcile-completed",
        reconcile: async (candidate) => {
          reconciled.push(candidate);
        },
      },
      runCandidate: async (provider, model, options) => {
        candidateCalls.push({
          provider,
          model,
          isFallbackRetry: options.isFallbackRetry,
          routingStage: options.modelRoutingProvenance.stage,
        });
        if (model === "gpt-daybreak-blue-latest") {
          return makeResult({ provider, model });
        }
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
      },
    });

    expect(candidateCalls).toEqual([
      {
        provider: "openai",
        model: "gpt-5.6",
        isFallbackRetry: false,
        routingStage: "initial",
      },
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
    await result.settleSessionOverride();
    expect(reconciled).toEqual([]);
  });

  it("preserves the original refusal and cools off an unauthorized Daybreak target", async () => {
    const searchedModels: string[] = [];
    state.runWithModelFallback.mockImplementation(async (params: FallbackRunnerParams) => {
      searchedModels.push(params.model);
      if (params.model === "gpt-daybreak-blue-latest") {
        throw Object.assign(new Error("401 unauthorized"), { status: 401 });
      }
      const candidate = await params.run(
        params.provider,
        params.model,
        initialAttemptOptions(params),
      );
      await params.classifyResult?.({
        result: candidate,
        provider: params.provider,
        model: params.model,
        attempt: 1,
        total: 1,
      });
      return {
        outcome: "completed" as const,
        result: candidate,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    const run = () =>
      runEmbeddedAgentEntry({
        selection: { cfg: {}, provider: "openai", model: "gpt-5.6" },
        identity: { runId: "run-cyber-cooloff", agentId: "main", sessionId: "session-1" },
        harness: createDirectHarness(),
        behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
        sessionOverride: { kind: "preserve" },
        runCandidate: async (provider, model) => ({
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
        }),
      });

    const first = await run();
    const second = await run();

    expect(first.model).toBe("gpt-5.6");
    expect(first.result.payloads).toEqual([{ text: "policy refusal", isError: true }]);
    expect(second.model).toBe("gpt-5.6");
    expect(searchedModels).toEqual(["gpt-5.6", "gpt-daybreak-blue-latest", "gpt-5.6"]);
  });

  it("keeps a failed Daybreak attempt that already committed work", async () => {
    state.runWithModelFallback.mockImplementation(async (params: FallbackRunnerParams) => {
      const candidate = await params.run(
        params.provider,
        params.model,
        initialAttemptOptions(params),
      );
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
    });

    const result = await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "openai", model: "gpt-5.6" },
      identity: { runId: "run-cyber-committed", agentId: "main", sessionId: "session-1" },
      harness: createDirectHarness(),
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model) => {
        if (model === "gpt-daybreak-blue-latest") {
          // The retry executed a tool and only then failed, so it is not
          // interchangeable with the replay-safe refusal it replaced.
          return {
            ...makeResult({ provider, model }),
            payloads: [{ text: "daybreak failed after running a tool", isError: true }],
            meta: {
              ...makeResult({ provider, model }).meta,
              replayInvalid: true,
              error: { kind: "incomplete_turn", message: "Daybreak failed mid-turn" },
            },
          };
        }
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
      },
    });

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
      // The fallback runner deliberately throws an unclassified error when the
      // attempt already committed work and may not be replaced.
      name: "an unclassified committed-work throw",
      makeError: () => new Error("attempt committed work; cannot fall back"),
    },
  ])("propagates $name thrown by the Daybreak retry", async ({ makeError }) => {
    const thrown = makeError();
    state.runWithModelFallback.mockImplementation(async (params: FallbackRunnerParams) => {
      if (params.model === "gpt-daybreak-blue-latest") {
        throw thrown;
      }
      const candidate = await params.run(
        params.provider,
        params.model,
        initialAttemptOptions(params),
      );
      await params.classifyResult?.({
        result: candidate,
        provider: params.provider,
        model: params.model,
        attempt: 1,
        total: 1,
      });
      return {
        outcome: "completed" as const,
        result: candidate,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });

    await expect(
      runEmbeddedAgentEntry({
        selection: { cfg: {}, provider: "openai", model: "gpt-5.6" },
        identity: { runId: "run-cyber-throw", agentId: "main", sessionId: "session-1" },
        harness: createDirectHarness(),
        behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
        sessionOverride: { kind: "preserve" },
        runCandidate: async (provider, model) => ({
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
        }),
      }),
    ).rejects.toBe(thrown);
  });

  it("does not escalate a preliminary refusal replaced by a successful final result", async () => {
    const searchedModels: string[] = [];
    state.runWithModelFallback.mockImplementation(async (params: FallbackRunnerParams) => {
      searchedModels.push(params.model);
      const candidate = await params.run(
        params.provider,
        params.model,
        initialAttemptOptions(params),
      );
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
    });

    const result = await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "openai", model: "gpt-5.6" },
      identity: { runId: "run-cyber-replaced", agentId: "main", sessionId: "session-1" },
      harness: createDirectHarness(),
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model, options) => {
        const preliminary = {
          ...makeResult({ provider, model }),
          payloads: [{ text: "preliminary refusal", isError: true }],
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
        options.classifyResult(preliminary);
        return makeResult({ provider, model });
      },
    });

    expect(searchedModels).toEqual(["gpt-5.6"]);
    expect(result.model).toBe("gpt-5.6");
    expect(result.result.payloads).toEqual([{ text: "recovered" }]);
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
    state.runWithModelFallback.mockImplementation(async (params: FallbackRunnerParams) => {
      const candidate = await params.run(
        params.provider,
        params.model,
        initialAttemptOptions(params),
      );
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
    });

    const result = await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "openai", model: "gpt-5.6" },
      identity: { runId: "run-cyber-preserve-returned", agentId: "main", sessionId: "session-1" },
      harness: createDirectHarness(),
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => committed },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model) => {
        if (model === "gpt-daybreak-blue-latest") {
          committed = commit;
          return {
            ...makeResult({ provider, model }),
            payloads: [{ text: "Daybreak did not complete", isError: true }],
            meta: { ...makeResult({ provider, model }).meta, ...targetMeta },
          };
        }
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
      },
    });

    expect(result.model).toBe("gpt-daybreak-blue-latest");
    expect(result.result.payloads).toEqual([{ text: "Daybreak did not complete", isError: true }]);
  });

  it("keeps a recovered Daybreak answer alongside a replay-safe tool warning", async () => {
    state.runWithModelFallback.mockImplementation(async (params: FallbackRunnerParams) => {
      const candidate = await params.run(
        params.provider,
        params.model,
        initialAttemptOptions(params),
      );
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
    });

    const result = await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "openai", model: "gpt-5.6" },
      identity: { runId: "run-cyber-warning", agentId: "main", sessionId: "session-1" },
      harness: createDirectHarness(),
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model) =>
        model === "gpt-daybreak-blue-latest"
          ? {
              ...makeResult({ provider, model }),
              payloads: [{ text: "Tool warning", isError: true }, { text: "Recovered answer" }],
            }
          : {
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
            },
    });

    expect(result.model).toBe("gpt-daybreak-blue-latest");
    expect(result.result.payloads).toEqual([
      { text: "Tool warning", isError: true },
      { text: "Recovered answer" },
    ]);
  });

  it("keeps a cyber refusal terminal for a strict model selection", async () => {
    const searchedModels: string[] = [];
    state.runWithModelFallback.mockImplementation(async (params: FallbackRunnerParams) => {
      searchedModels.push(params.model);
      const candidate = await params.run(
        params.provider,
        params.model,
        initialAttemptOptions(params),
      );
      await params.classifyResult?.({
        result: candidate,
        provider: params.provider,
        model: params.model,
        attempt: 1,
        total: 1,
      });
      return {
        outcome: "completed" as const,
        result: candidate,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });

    const result = await runEmbeddedAgentEntry({
      selection: {
        cfg: {},
        provider: "openai",
        model: "gpt-5.6",
        // A locked model selection reaches the runner as an explicit empty
        // fallback list; no other model may serve the turn.
        fallbacksOverride: [],
      },
      identity: { runId: "run-cyber-strict", agentId: "main", sessionId: "session-1" },
      harness: createDirectHarness(),
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model) => ({
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
      }),
    });

    expect(searchedModels).toEqual(["gpt-5.6"]);
    expect(result.model).toBe("gpt-5.6");
    expect(result.result.payloads).toEqual([{ text: "policy refusal", isError: true }]);
  });

  it("restores the original refusal transcript when Daybreak fails", async () => {
    const transcript = await import("../../config/sessions/transcript.js");
    const { makeAssistantMessageFixture } =
      await import("../test-helpers/assistant-message-fixtures.js");
    const append = vi
      .spyOn(transcript, "appendExactAssistantMessageToSessionTranscript")
      .mockResolvedValue({
        ok: true,
        target: {
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          storePath: "/tmp/unused-cyber-transcript.sqlite",
        },
        messageId: "assistant-error",
      });
    state.runWithModelFallback.mockImplementation(async (params: FallbackRunnerParams) => {
      const candidate = await params.run(
        params.provider,
        params.model,
        initialAttemptOptions(params),
      );
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
    });
    try {
      await runEmbeddedAgentEntry({
        selection: { cfg: {}, provider: "openai", model: "gpt-5.6" },
        identity: { runId: "run-cyber-transcript", agentId: "main", sessionId: "session-1" },
        harness: createDirectHarness(),
        behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
        sessionOverride: { kind: "preserve" },
        runCandidate: async (provider, model, options) => {
          options.assistantErrorTranscript.record(
            makeAssistantMessageFixture({
              provider,
              model,
              errorMessage:
                model === "gpt-daybreak-blue-latest"
                  ? "Daybreak unauthorized"
                  : "Original cyber refusal",
              diagnostics:
                model === "gpt-daybreak-blue-latest"
                  ? undefined
                  : [
                      {
                        type: "provider_refusal",
                        timestamp: 1,
                        details: { provider: "openai", category: "cyber" },
                      },
                    ],
            }),
            {
              agentId: "main",
              sessionId: "session-1",
              sessionKey: "agent:main:session-1",
              storePath: "/tmp/unused-cyber-transcript.sqlite",
            },
          );
          if (model === "gpt-daybreak-blue-latest") {
            throw Object.assign(new Error("401 unauthorized"), { status: 401 });
          }
          return {
            ...makeResult({ provider, model }),
            payloads: [{ text: "policy refusal", isError: true }],
            meta: {
              ...makeResult({ provider, model }).meta,
              error: { kind: "incomplete_turn", message: "Original cyber refusal" },
              agentMeta: {
                sessionId: "session-1",
                provider,
                model,
                agentHarnessId: "openclaw",
                providerRefusal: { provider: "openai", category: "cyber" },
              },
            },
          };
        },
      });
      expect(append).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ errorMessage: "Original cyber refusal" }),
        }),
      );
    } finally {
      append.mockRestore();
    }
  });
});
