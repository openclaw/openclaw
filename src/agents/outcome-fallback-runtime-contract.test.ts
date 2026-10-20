// Verifies embedded runtime outcome classifications drive model fallback correctly.

import { expectDefined } from "@openclaw/normalization-core";
import {
  createContractRunResult,
  OUTCOME_FALLBACK_RUNTIME_CONTRACT,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { resolveTerminalAgentRunFailurePayload } from "../auto-reply/reply/agent-runner-failure-reply.js";
import { applyInputProvenanceToUserMessage } from "../sessions/input-provenance.js";
import {
  classifyEmbeddedAgentRunResultForModelFallback,
  mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
} from "./embedded-agent-runner/result-fallback-classifier.js";
import {
  buildRunEntryTerminal,
  resolveRunEntryTerminalOutcome,
} from "./embedded-agent-runner/run-entry-terminal.js";
import { resolveEmbeddedRunTerminal } from "./embedded-agent-runner/run/terminal-resolution.js";
import {
  emptyAssistant,
  makeTerminalInput,
} from "./embedded-agent-runner/run/terminal-resolution.test-support.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import {
  createMockUsage,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

// mock-isolation: Outcome classification skips auth runtime and must not initialize credential-source state.
vi.mock("./auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSourceAsync: () => false,
}));

const contractFallbackOverride = [
  // Keep fallback target aligned with the plugin-sdk runtime contract fixture.
  `${OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider}/${OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel}`,
];

const contractRunOptions = {
  cfg: undefined,
  provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
  model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
  fallbacksOverride: contractFallbackOverride,
  classifyResult: classifyEmbeddedAgentRunResultForModelFallback,
  skipAuthProfileRuntime: true,
};

describe("Outcome/fallback runtime contract - embedded runtime fallback classifier", () => {
  beforeAll(async () => {
    await runWithModelFallback({
      cfg: undefined,
      provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
      model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
      fallbacksOverride: [],
      run: vi.fn().mockResolvedValue(createContractRunResult({ meta: { durationMs: 1 } })),
      skipAuthProfileRuntime: true,
    });
  });

  it.each([
    ["optional", undefined, 1, 1],
    ["optional", "empty", 1, 1],
    ["optional", "reasoning-only", 1, 1],
    ["result-required", undefined, 1, 2],
    ["result-required", "empty", 3, 6],
    ["result-required", "reasoning-only", 3, 9],
    ["required", "empty", 3, 6],
    ["required", "reasoning-only", 3, 9],
  ] as const)(
    "settles an empty stop for %s replies with harness classification %s",
    async (expectation, classification, expectedModels, expectedRequests) => {
      const prompt = "The result is already incorporated. No new update.";
      const provenance = { kind: "inter_session" as const, sourceTool: "sessions_send" };
      // Recorded shape: fresh inter-session input, response.completed, blank text,
      // four output tokens, no tool calls or compaction. Content is synthetic.
      const assistant = emptyAssistant({
        ...(classification === "reasoning-only"
          ? { content: [{ type: "thinking" as const, thinking: "checking" }] }
          : {}),
        stopReason: "stop",
        usage: createMockUsage(89, 4),
      });
      let modelRequests = 0;
      const notices: ReplyPayload[] = [];
      const run = vi.fn(async () => {
        const attempt = makeEmbeddedRunnerAttempt({
          assistantTexts: [],
          agentHarnessResultClassification: classification,
          messagesSnapshot: [
            expectation === "required"
              ? { role: "user" as const, content: prompt, timestamp: 0 }
              : applyInputProvenanceToUserMessage(
                  { role: "user", content: prompt, timestamp: 0 },
                  provenance,
                ),
            assistant,
          ],
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
          currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        });
        const input = makeTerminalInput({
          attempt,
          runParams: {
            prompt,
            inputProvenance: expectation === "required" ? undefined : provenance,
            terminalReplyExpectation: expectation,
          },
        });
        for (;;) {
          modelRequests += 1;
          const terminal = await resolveEmbeddedRunTerminal(input);
          if (terminal.action === "complete") {
            notices.push(
              ...(terminal.result.payloads?.filter((payload) => payload.isStatusNotice) ?? []),
            );
            expect(terminal.result.payloads).toBeUndefined();
            expect(terminal.result.meta.terminalReply).toEqual({ disposition: "empty" });
            expect(terminal.result.meta.finalAssistantVisibleText).toBe(
              expectation === "optional" ? "" : undefined,
            );
            expect(terminal.result.meta.finalAssistantRawText).toBeUndefined();
            return terminal.result;
          }
        }
      });

      const result = await runWithModelFallback({
        cfg: undefined,
        provider: "openai",
        model: "gpt-5.6-sol",
        fallbacksOverride: ["openai/gpt-5.6-terra", "openai/gpt-5.6-luna"],
        skipAuthProfileRuntime: true,
        classifyResult: classifyEmbeddedAgentRunResultForModelFallback,
        run,
      });

      expect(run).toHaveBeenCalledTimes(expectedModels);
      expect(modelRequests).toBe(expectedRequests);
      const fallbackExpected = expectation !== "optional" && classification !== undefined;
      expect(result.model).toBe(fallbackExpected ? "gpt-5.6-luna" : "gpt-5.6-sol");
      expect(result.attempts).toHaveLength(fallbackExpected ? 3 : 0);
      expect(result.result.meta.error?.kind).toBe(
        expectation === "optional" ? undefined : "incomplete_turn",
      );
      expect(result.result.meta.terminalReply).toEqual({ disposition: "empty" });
      expect(result.result.meta.finalAssistantVisibleText).toBe(
        expectation === "optional" ? "" : undefined,
      );
      expect(result.result.meta.finalAssistantRawText).toBeUndefined();
      expect(result.result.payloads).toBeUndefined();
      expect(notices).toEqual([]);
      if (!result.result.meta.error) {
        return;
      }
      const notice = await resolveTerminalAgentRunFailurePayload({
        result: result.result,
        run: {
          messageChannel: "telegram",
          terminalReplyExpectation: expectation,
          inputProvenance: expectation === "required" ? undefined : provenance,
        },
        visibleReplyDelivered: async () => false,
      });
      if (notice) {
        notices.push(notice);
      }
      if (expectation === "required") {
        expect(result.outcome).toBe("exhausted");
        expect(notices).toEqual([
          expect.objectContaining({
            text: "No answer was returned. Ask again if you still need one.",
            isError: true,
            isStatusNotice: true,
          }),
        ]);
        expect(getReplyPayloadMetadata(notice ?? {})?.assistantTranscriptOwned).toBe(true);
      } else {
        expect(notices).toEqual([]);
      }
    },
  );

  const fallbackClassificationCases = [
    ["empty", "empty_result"],
    ["reasoning-only", "reasoning_only_result"],
    ["planning-only", "planning_only_result"],
  ] as const;

  it.each(fallbackClassificationCases)(
    "maps harness classification %s to a format fallback code",
    (classification, code) => {
      const fallback = classifyEmbeddedAgentRunResultForModelFallback({
        provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
        model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
        result: createContractRunResult({
          meta: {
            durationMs: 1,
            agentHarnessResultClassification: classification,
          },
        }),
      });
      if (!fallback || !("reason" in fallback)) {
        throw new Error(`Expected format fallback detail for ${classification}`);
      }
      expect(fallback?.reason).toBe("format");
      expect(fallback?.code).toBe(code);
    },
  );

  it("advances to the configured fallback after an invisible non-GPT terminal result", async () => {
    const primaryProvider = "zai";
    const primaryModel = "glm-5.2";
    const primary = createContractRunResult({
      payloads: [{ isReasoning: true, text: "thinking" }, { text: " " }],
    });
    const fallback = createContractRunResult({
      payloads: [{ text: "fallback ok" }],
      meta: { durationMs: 1, finalAssistantVisibleText: "fallback ok" },
    });
    const run = vi.fn().mockResolvedValueOnce(primary).mockResolvedValueOnce(fallback);

    const result = await runWithModelFallback<ReturnType<typeof createContractRunResult>>({
      cfg: undefined,
      provider: primaryProvider,
      model: primaryModel,
      fallbacksOverride: contractFallbackOverride,
      run,
      classifyResult: ({ provider, model, result: resultValue }) =>
        classifyEmbeddedAgentRunResultForModelFallback({
          provider,
          model,
          result: resultValue,
        }),
      mergeExhaustedResult: mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
      skipAuthProfileRuntime: true,
    });

    expect(result.outcome).toBe("completed");
    expect(result.result).toBe(fallback);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.at(1)).toEqual([
      OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider,
      OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel,
      {
        isFinalFallbackAttempt: true,
        modelRoutingProvenance: {
          requestedProvider: primaryProvider,
          requestedModel: primaryModel,
          stage: "fallback",
          selectionChanged: false,
          fallbackReason: "format",
        },
      },
    ]);
    expect(result.attempts[0]?.provider).toBe(primaryProvider);
    expect(result.attempts[0]?.model).toBe(primaryModel);
    expect(result.attempts[0]?.reason).toBe("format");
    expect(result.attempts[0]?.code).toBe("empty_result");
  });

  it("preserves an incomplete tool-authored summary over stale silence when fallbacks exhaust", async () => {
    const terminalSummary =
      "Web fetch completed.\nOrigin: https://example.com\nStatus: 200\n\n" +
      "Agent couldn't generate a response.";
    const incomplete = createContractRunResult({
      payloads: [{ text: terminalSummary, isError: true }],
      meta: {
        durationMs: 1,
        terminalReply: { disposition: "silent" },
        toolSummary: { calls: 1, tools: ["web_fetch"] },
        error: {
          kind: "incomplete_turn",
          message: "Agent couldn't generate a response.",
          fallbackSafe: true,
          terminalPresentation: true,
        },
      },
    });

    const result = await runWithModelFallback<ReturnType<typeof createContractRunResult>>({
      ...contractRunOptions,
      fallbacksOverride: [],
      run: vi.fn().mockResolvedValue(incomplete),
      mergeExhaustedResult: mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
    });

    expect(result.outcome).toBe("exhausted");
    expect(result.result).toBe(incomplete);
    expect(result.result.payloads).toEqual([{ text: terminalSummary, isError: true }]);
    expect(result.attempts).toMatchObject([
      {
        provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
        model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
        reason: "format",
        code: "incomplete_result",
      },
    ]);
  });

  it("keeps an internal missing-result notice private after a later provider candidate fails", async () => {
    const missing = createContractRunResult({
      payloads: [],
      meta: {
        durationMs: 1,
        stopReason: "error",
        suppressErrorNotice: true,
        terminalReply: { disposition: "empty" },
        error: {
          kind: "incomplete_turn",
          message: "No answer was returned. Ask again if you still need one.",
          fallbackSafe: true,
        },
      },
    });
    const provider = createContractRunResult({
      payloads: [{ isError: true, text: "HTTP 500: internal server error" }],
      meta: { durationMs: 2, stopReason: "error" },
    });
    const run = vi.fn().mockResolvedValueOnce(missing).mockResolvedValueOnce(provider);
    const result = await runWithModelFallback<ReturnType<typeof createContractRunResult>>({
      ...contractRunOptions,
      run,
      mergeExhaustedResult: mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
    });
    const terminal = buildRunEntryTerminal({
      result: result.result,
      outcome: resolveRunEntryTerminalOutcome({ result: result.result, fallbackExhausted: true }),
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
      runId: "internal-result-run",
      sessionId: "internal-result-session",
      requested: { provider: "external", model: "primary" },
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe("exhausted");
    expect(result.result.meta.durationMs).toBe(2);
    expect(result.result.meta.error).toBe(missing.meta.error);
    expect(result.result.meta.suppressErrorNotice).toBe(true);
    expect(result.attempts.at(-1)).toMatchObject({
      reason: "server_error",
      error: expect.stringContaining("HTTP 500: internal server error"),
    });
    expect(terminal.outcome.status).toBe("error");
    expect(terminal.metadata.suppressErrorNotice).toBe(true);
  });

  it("preserves the latest structured summary after all fallback candidates are exhausted", async () => {
    const primary = createContractRunResult({
      payloads: [{ text: "Primary terminal summary", isError: true }],
      meta: {
        durationMs: 1,
        error: {
          kind: "incomplete_turn",
          message: "Primary incomplete",
          fallbackSafe: true,
        },
      },
    });
    const fallback = createContractRunResult({
      payloads: [{ text: "Fallback terminal summary", isError: true }],
      meta: {
        durationMs: 1,
        error: {
          kind: "incomplete_turn",
          message: "Fallback incomplete",
          fallbackSafe: true,
        },
      },
    });
    const run = vi.fn().mockResolvedValueOnce(primary).mockResolvedValueOnce(fallback);

    const result = await runWithModelFallback({
      ...contractRunOptions,
      run,
      mergeExhaustedResult: mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
    });

    expect(result.outcome).toBe("exhausted");
    expect(result.result).toBe(fallback);
    expect(result.provider).toBe(OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider);
    expect(result.model).toBe(OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel);
    expect(result.attempts).toHaveLength(2);
  });

  it.each([undefined, false])(
    "keeps a richer terminal presentation and its notice policy (%s) over a later generic incomplete result",
    async (suppressErrorNotice) => {
      const primary = createContractRunResult({
        payloads: [{ text: "Primary terminal summary", isError: true }],
        meta: {
          durationMs: 1,
          ...(suppressErrorNotice === undefined ? {} : { suppressErrorNotice }),
          agentMeta: {
            sessionId: "primary-session",
            sessionFile: "/tmp/primary.jsonl",
            provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
            model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
          },
          error: {
            kind: "incomplete_turn",
            message: "Primary incomplete",
            fallbackSafe: true,
            terminalPresentation: true,
          },
        },
      });
      const fallback = createContractRunResult({
        payloads: [{ text: "Generic fallback incomplete", isError: true }],
        meta: {
          durationMs: 1,
          suppressErrorNotice: true,
          agentMeta: {
            sessionId: "fallback-session",
            sessionFile: "/tmp/fallback.jsonl",
            provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider,
            model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel,
          },
          executionTrace: {
            winnerProvider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider,
            winnerModel: OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel,
            fallbackUsed: true,
            runner: "embedded",
            attempts: [
              {
                provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider,
                model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel,
                result: "success",
              },
            ],
          },
          error: {
            kind: "incomplete_turn",
            message: "Fallback incomplete",
            fallbackSafe: true,
          },
        },
      });
      const run = vi.fn().mockResolvedValueOnce(primary).mockResolvedValueOnce(fallback);

      const result = await runWithModelFallback<ReturnType<typeof createContractRunResult>>({
        ...contractRunOptions,
        run,
        mergeExhaustedResult: mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
      });

      expect(result.outcome).toBe("exhausted");
      expect(result.result.payloads).toBe(primary.payloads);
      expect(result.result.meta.error).toBe(primary.meta.error);
      expect(result.result.meta.suppressErrorNotice).toBe(suppressErrorNotice);
      expect(result.result.meta.agentMeta).toBe(fallback.meta.agentMeta);
      expect(result.result.meta.executionTrace).toEqual({
        winnerProvider: undefined,
        winnerModel: undefined,
        fallbackUsed: true,
        runner: "embedded",
        attempts: undefined,
      });
      expect(result.provider).toBe(OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider);
      expect(result.model).toBe(OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel);
      expect(result.attempts).toHaveLength(2);
    },
  );

  it("rethrows an unrecognized final failure instead of hiding it behind an earlier summary", async () => {
    const primary = createContractRunResult({
      payloads: [{ text: "Primary terminal summary", isError: true }],
      meta: {
        durationMs: 1,
        error: {
          kind: "incomplete_turn",
          message: "Primary incomplete",
          fallbackSafe: true,
        },
      },
    });
    const finalError = new Error("fallback runtime crashed");
    const run = vi.fn().mockResolvedValueOnce(primary).mockRejectedValueOnce(finalError);

    await expect(
      runWithModelFallback<ReturnType<typeof createContractRunResult>>({
        ...contractRunOptions,
        run,
      }),
    ).rejects.toBe(finalError);
    expect(run).toHaveBeenCalledTimes(2);
  });

  const nonFallbackCases = [
    {
      name: "intentional NO_REPLY",
      result: createContractRunResult({
        meta: {
          durationMs: 1,
          agentHarnessResultClassification: "empty",
          finalAssistantRawText: "NO_REPLY",
          terminalReply: { disposition: "silent" },
        },
      }),
    },
    {
      name: "visible reply",
      result: createContractRunResult({
        payloads: [{ text: "visible answer" }],
        meta: { durationMs: 1 },
      }),
    },
    {
      name: "abort",
      result: createContractRunResult({
        meta: { durationMs: 1, aborted: true, agentHarnessResultClassification: "empty" },
      }),
    },
    {
      name: "structured replay side effect",
      result: createContractRunResult({
        meta: {
          durationMs: 1,
          replayInvalid: true,
          toolSummary: { calls: 1, tools: ["message"] },
        },
      }),
    },
    {
      name: "messaging text side effect",
      result: createContractRunResult({
        messagingToolSentTexts: ["sent out of band"],
        meta: { durationMs: 1, agentHarnessResultClassification: "empty" },
      }),
    },
    {
      name: "messaging media side effect",
      result: createContractRunResult({
        messagingToolSentMediaUrls: ["https://example.test/image.png"],
        meta: { durationMs: 1, agentHarnessResultClassification: "empty" },
      }),
    },
    {
      name: "messaging target side effect",
      result: createContractRunResult({
        messagingToolSentTargets: [{ tool: "message", provider: "slack", to: "channel-1" }],
        meta: { durationMs: 1, agentHarnessResultClassification: "empty" },
      }),
    },
    {
      name: "cron side effect",
      result: createContractRunResult({
        successfulCronAdds: 1,
        meta: { durationMs: 1, agentHarnessResultClassification: "empty" },
      }),
    },
    {
      name: "direct block reply",
      result: createContractRunResult({
        meta: { durationMs: 1, agentHarnessResultClassification: "empty" },
      }),
      hasDirectlySentBlockReply: true,
    },
    {
      name: "block reply pipeline output",
      result: createContractRunResult({
        meta: { durationMs: 1, agentHarnessResultClassification: "empty" },
      }),
      hasBlockReplyPipelineOutput: true,
    },
  ];

  it("does not classify terminal results with visible output or side effects as fallbacks", () => {
    // Any visible reply or out-of-band side effect is a successful terminal outcome.
    for (const contractCase of nonFallbackCases) {
      expect(
        classifyEmbeddedAgentRunResultForModelFallback({
          provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
          model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
          result: contractCase.result,
          hasDirectlySentBlockReply: contractCase.hasDirectlySentBlockReply,
          hasBlockReplyPipelineOutput: contractCase.hasBlockReplyPipelineOutput,
        }),
      ).toBeNull();
    }
  });

  it("keeps running on the primary when terminal output is not classified as fallback", async () => {
    const contractCase = expectDefined(nonFallbackCases[0], "nonFallbackCases[0] test invariant");
    const run = vi.fn().mockResolvedValue(contractCase.result);
    const result = await runWithModelFallback({
      ...contractRunOptions,
      run,
      classifyResult: ({ provider, model, result: resultLocal }) =>
        classifyEmbeddedAgentRunResultForModelFallback({
          provider,
          model,
          result: resultLocal,
          hasDirectlySentBlockReply: contractCase.hasDirectlySentBlockReply,
          hasBlockReplyPipelineOutput: contractCase.hasBlockReplyPipelineOutput,
        }),
    });

    expect(result.outcome).toBe("completed");
    expect(result.result).toBe(contractCase.result);
    expect(result.attempts).toStrictEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
