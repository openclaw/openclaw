import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedClassifyFailoverReason,
  mockedEnsureAuthProfileStore,
  mockedMarkAuthProfileFailure,
  mockedResolveAuthProfileOrder,
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent iteration budget", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("leaves runs unchanged when no limit is configured", async () => {
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (rawParams) => {
      const attemptParams = rawParams as Pick<EmbeddedRunAttemptParams, "onBeforeToolCallingRound">;
      expect(attemptParams.onBeforeToolCallingRound).toBeUndefined();
      return makeAttemptResult({
        assistantTexts: ["Done."],
        messagesSnapshot: [],
        promptError: null,
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      config: { agents: { defaults: {} } },
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(result.meta.error).toBeUndefined();
  });

  it("returns budget_exhausted after the configured tool-calling rounds", async () => {
    const budgetDecisions: boolean[] = [];
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (rawParams) => {
        const attemptParams = rawParams as Pick<
          EmbeddedRunAttemptParams,
          "onBeforeToolCallingRound"
        >;
        if (!attemptParams.onBeforeToolCallingRound) {
          throw new Error("Expected iteration budget callback");
        }
        budgetDecisions.push(await attemptParams.onBeforeToolCallingRound(1));
        budgetDecisions.push(await attemptParams.onBeforeToolCallingRound(2));
        budgetDecisions.push(await attemptParams.onBeforeToolCallingRound(3));
        return makeAttemptResult({ assistantTexts: [], messagesSnapshot: [], promptError: null });
      })
      .mockImplementationOnce(async () =>
        makeAttemptResult({ assistantTexts: [], messagesSnapshot: [], promptError: null }),
      );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      config: {
        agents: {
          defaults: {
            maxToolCallingRounds: 2,
          },
        },
      },
    });

    expect(budgetDecisions).toEqual([true, true, false]);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.meta.error?.kind).toBe("budget_exhausted");
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.replayInvalid).toBe(true);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("2/2");
  });

  it("runs one final text-only summary attempt after exhaustion", async () => {
    const summaryPrompts: string[] = [];
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (rawParams) => {
        const attemptParams = rawParams as Pick<
          EmbeddedRunAttemptParams,
          "onBeforeToolCallingRound"
        >;
        if (!attemptParams.onBeforeToolCallingRound) {
          throw new Error("Expected iteration budget callback");
        }
        expect(await attemptParams.onBeforeToolCallingRound(1)).toBe(true);
        expect(await attemptParams.onBeforeToolCallingRound(2)).toBe(false);
        return makeAttemptResult({
          assistantTexts: [],
          messagesSnapshot: [],
          promptError: null,
          didSendViaMessagingTool: true,
          messagingToolSentTexts: ["Already delivered"],
          successfulCronAdds: 1,
          acceptedSessionSpawns: [{ runId: "child-run", childSessionKey: "agent:child" }],
        });
      })
      .mockImplementationOnce(async (rawParams) => {
        const attemptParams = rawParams as Pick<EmbeddedRunAttemptParams, "prompt">;
        summaryPrompts.push(attemptParams.prompt);
        return makeAttemptResult({
          assistantTexts: ["Completed the investigation; implementation remains."],
          messagesSnapshot: [],
          promptError: null,
        });
      });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      config: {
        agents: {
          defaults: {
            maxToolCallingRounds: 1,
          },
        },
      },
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(summaryPrompts[0]).toContain("configured tool-calling round limit");
    expect(summaryPrompts[0]).toContain("Do NOT make any tool calls");
    expect(result.payloads?.[0]).toEqual({
      text: "Completed the investigation; implementation remains.",
      isError: false,
    });
    expect(result.meta.error?.kind).toBe("budget_exhausted");
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toEqual(["Already delivered"]);
    expect(result.successfulCronAdds).toBe(1);
    expect(result.acceptedSessionSpawns).toEqual([
      { runId: "child-run", childSessionKey: "agent:child" },
    ]);
  });

  it("reserves the final summary attempt outside the run retry limit", async () => {
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (rawParams) => {
        const attemptParams = rawParams as Pick<
          EmbeddedRunAttemptParams,
          "onBeforeToolCallingRound"
        >;
        if (!attemptParams.onBeforeToolCallingRound) {
          throw new Error("Expected iteration budget callback");
        }
        expect(await attemptParams.onBeforeToolCallingRound(1)).toBe(true);
        expect(await attemptParams.onBeforeToolCallingRound(2)).toBe(false);
        return makeAttemptResult({ assistantTexts: [], messagesSnapshot: [], promptError: null });
      })
      .mockImplementationOnce(async () =>
        makeAttemptResult({ assistantTexts: ["Final summary."], messagesSnapshot: [] }),
      );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      config: {
        agents: {
          defaults: {
            runRetries: { base: 1, perProfile: 0, min: 1, max: 1 },
            maxToolCallingRounds: 1,
          },
        },
      },
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.meta.error?.kind).toBe("budget_exhausted");
    expect(result.payloads?.[0]?.text).toBe("Final summary.");
  });

  it.each([
    [
      "prompt error",
      {
        promptError: new Error("summary failed"),
        promptErrorSource: "prompt" as const,
      },
    ],
    [
      "context overflow",
      {
        promptError: new Error("context window exceeded"),
        promptErrorSource: "prompt" as const,
      },
    ],
    ["timeout", { timedOut: true }],
  ])(
    "returns budget_exhausted when the final summary attempt ends with a %s",
    async (_name, failure) => {
      mockedRunEmbeddedAttempt
        .mockImplementationOnce(async (rawParams) => {
          const attemptParams = rawParams as Pick<
            EmbeddedRunAttemptParams,
            "onBeforeToolCallingRound"
          >;
          if (!attemptParams.onBeforeToolCallingRound) {
            throw new Error("Expected iteration budget callback");
          }
          expect(await attemptParams.onBeforeToolCallingRound(1)).toBe(true);
          expect(await attemptParams.onBeforeToolCallingRound(2)).toBe(false);
          return makeAttemptResult({ assistantTexts: [], messagesSnapshot: [], promptError: null });
        })
        .mockImplementationOnce(async () =>
          makeAttemptResult({
            assistantTexts: [],
            messagesSnapshot: [],
            ...failure,
          }),
        );

      const result = await runEmbeddedAgent({
        ...overflowBaseRunParams,
        allowEmptyAssistantReplyAsSilent: true,
        config: {
          agents: {
            defaults: {
              maxToolCallingRounds: 1,
            },
          },
        },
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      expect(result.meta.error?.kind).toBe("budget_exhausted");
      expect(result.meta.livenessState).toBe("blocked");
      expect(result.payloads?.[0]?.isError).toBe(true);
    },
  );

  it("preserves internal restart cancellation during the final summary", async () => {
    const restartError = createAgentRunRestartAbortError();
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (rawParams) => {
        const attemptParams = rawParams as Pick<
          EmbeddedRunAttemptParams,
          "onBeforeToolCallingRound"
        >;
        expect(await attemptParams.onBeforeToolCallingRound?.(1)).toBe(true);
        expect(await attemptParams.onBeforeToolCallingRound?.(2)).toBe(false);
        return makeAttemptResult({ assistantTexts: [], messagesSnapshot: [] });
      })
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          messagesSnapshot: [],
          promptError: restartError,
          promptErrorSource: "prompt",
        }),
      );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      config: { agents: { defaults: { maxToolCallingRounds: 1 } } },
    });

    expect(result.meta.aborted).toBe(true);
    expect(result.meta.error?.kind).toBe("incomplete_turn");
  });

  it("keeps the summary pending across preflight-only recovery", async () => {
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (rawParams) => {
        const attemptParams = rawParams as Pick<
          EmbeddedRunAttemptParams,
          "onBeforeToolCallingRound"
        >;
        expect(await attemptParams.onBeforeToolCallingRound?.(1)).toBe(true);
        expect(await attemptParams.onBeforeToolCallingRound?.(2)).toBe(false);
        return makeAttemptResult({ assistantTexts: [], messagesSnapshot: [] });
      })
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          messagesSnapshot: [],
          preflightRecovery: {
            route: "truncate_tool_results_only",
            handled: true,
            truncatedCount: 1,
          },
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({ assistantTexts: ["Final summary."], messagesSnapshot: [] }),
      );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      config: { agents: { defaults: { maxToolCallingRounds: 1 } } },
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.meta.error?.kind).toBe("budget_exhausted");
    expect(result.payloads?.[0]?.text).toBe("Final summary.");
  });

  it("bounds repeated preflight-only recovery while the summary is pending", async () => {
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (rawParams) => {
        const attemptParams = rawParams as Pick<
          EmbeddedRunAttemptParams,
          "onBeforeToolCallingRound"
        >;
        expect(await attemptParams.onBeforeToolCallingRound?.(1)).toBe(true);
        expect(await attemptParams.onBeforeToolCallingRound?.(2)).toBe(false);
        return makeAttemptResult({ assistantTexts: [], messagesSnapshot: [] });
      })
      .mockImplementation(async () =>
        makeAttemptResult({
          assistantTexts: [],
          messagesSnapshot: [],
          preflightRecovery: {
            route: "truncate_tool_results_only",
            handled: true,
          },
        }),
      );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      config: {
        agents: {
          defaults: {
            runRetries: { base: 1, perProfile: 0, min: 1, max: 1 },
            maxToolCallingRounds: 1,
          },
        },
      },
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.meta.error?.kind).toBe("budget_exhausted");
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("records credential failure when the final summary prompt fails", async () => {
    mockedEnsureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:test": {
          type: "api_key",
          provider: "anthropic",
          key: "test-key",
        },
      },
      order: { anthropic: ["anthropic:test"] },
    });
    mockedResolveAuthProfileOrder.mockReturnValue(["anthropic:test"]);
    mockedClassifyFailoverReason.mockReturnValue("auth");
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (rawParams) => {
        const attemptParams = rawParams as Pick<
          EmbeddedRunAttemptParams,
          "onBeforeToolCallingRound"
        >;
        expect(await attemptParams.onBeforeToolCallingRound?.(1)).toBe(true);
        expect(await attemptParams.onBeforeToolCallingRound?.(2)).toBe(false);
        return makeAttemptResult({ assistantTexts: [], messagesSnapshot: [] });
      })
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          messagesSnapshot: [],
          promptError: new Error("unauthorized"),
          promptErrorSource: "prompt",
        }),
      );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      config: { agents: { defaults: { maxToolCallingRounds: 1 } } },
    });

    expect(result.meta.error?.kind).toBe("budget_exhausted");
    expect(mockedMarkAuthProfileFailure).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "anthropic:test", reason: "auth" }),
    );
  });

  it("rejects partial summary text when the fallback assistant errored", async () => {
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (rawParams) => {
        const attemptParams = rawParams as Pick<
          EmbeddedRunAttemptParams,
          "onBeforeToolCallingRound"
        >;
        expect(await attemptParams.onBeforeToolCallingRound?.(1)).toBe(true);
        expect(await attemptParams.onBeforeToolCallingRound?.(2)).toBe(false);
        return makeAttemptResult({ assistantTexts: [], messagesSnapshot: [] });
      })
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Partial summary."],
          messagesSnapshot: [],
          lastAssistant: makeAssistantMessageFixture({
            stopReason: "error",
            errorMessage: "summary failed",
            provider: "anthropic",
            model: "test-model",
            content: [],
          }),
          currentAttemptAssistant: undefined,
        }),
      );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      config: { agents: { defaults: { maxToolCallingRounds: 1 } } },
    });

    expect(result.meta.error?.kind).toBe("budget_exhausted");
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).not.toBe("Partial summary.");
  });

  it("uses the spawned-run limit for subagents", async () => {
    const budgetDecisions: boolean[] = [];
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (rawParams) => {
        const attemptParams = rawParams as Pick<
          EmbeddedRunAttemptParams,
          "onBeforeToolCallingRound"
        >;
        if (!attemptParams.onBeforeToolCallingRound) {
          throw new Error("Expected iteration budget callback");
        }
        budgetDecisions.push(await attemptParams.onBeforeToolCallingRound(1));
        budgetDecisions.push(await attemptParams.onBeforeToolCallingRound(2));
        return makeAttemptResult({ assistantTexts: [], messagesSnapshot: [], promptError: null });
      })
      .mockImplementationOnce(async () =>
        makeAttemptResult({ assistantTexts: ["Partial summary."], messagesSnapshot: [] }),
      );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      spawnedBy: "agent:main:main",
      allowEmptyAssistantReplyAsSilent: true,
      config: {
        agents: {
          defaults: {
            maxToolCallingRounds: 5,
            subagents: { maxToolCallingRounds: 1 },
          },
        },
      },
    });

    expect(budgetDecisions).toEqual([true, false]);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("rejects summary preamble text when the model attempts another tool round", async () => {
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (rawParams) => {
        const attemptParams = rawParams as Pick<
          EmbeddedRunAttemptParams,
          "onBeforeToolCallingRound"
        >;
        if (!attemptParams.onBeforeToolCallingRound) {
          throw new Error("Expected iteration budget callback");
        }
        expect(await attemptParams.onBeforeToolCallingRound(1)).toBe(true);
        expect(await attemptParams.onBeforeToolCallingRound(2)).toBe(false);
        return makeAttemptResult({ assistantTexts: [], messagesSnapshot: [], promptError: null });
      })
      .mockImplementationOnce(async (rawParams) => {
        const attemptParams = rawParams as Pick<
          EmbeddedRunAttemptParams,
          "onBeforeToolCallingRound"
        >;
        if (!attemptParams.onBeforeToolCallingRound) {
          throw new Error("Expected iteration budget callback");
        }
        expect(await attemptParams.onBeforeToolCallingRound(1)).toBe(false);
        return makeAttemptResult({
          assistantTexts: ["Let me check one more thing."],
          messagesSnapshot: [],
          promptError: null,
        });
      });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      config: {
        agents: {
          defaults: {
            maxToolCallingRounds: 1,
          },
        },
      },
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Tool-calling round limit reached");
    expect(result.payloads?.[0]?.text).not.toContain("Let me check one more thing.");
  });
});
