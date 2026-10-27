import {
  createContractRunResult,
  OUTCOME_FALLBACK_RUNTIME_CONTRACT as contract,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { resolveTerminalAgentRunFailurePayload } from "../auto-reply/reply/agent-runner-failure-reply.js";
import { applyInputProvenanceToUserMessage } from "../sessions/input-provenance.js";
import {
  classifyEmbeddedAgentRunResultForModelFallback as classifyResult,
  mergeEmbeddedAgentRunResultForModelFallbackExhaustion as mergeExhaustedResult,
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

const contractFallbackOverride = [`${contract.fallbackProvider}/${contract.fallbackModel}`];

const contractRunOptions = {
  cfg: undefined,
  provider: contract.primaryProvider,
  model: contract.primaryModel,
  fallbacksOverride: contractFallbackOverride,
  classifyResult,
  skipAuthProfileRuntime: true,
};

type RunResult = ReturnType<typeof createContractRunResult>;
type RunMeta = RunResult["meta"];
type FallbackOptions = Parameters<typeof runWithModelFallback<RunResult>>[0];

async function runCandidates(candidates: RunResult[], overrides: Partial<FallbackOptions> = {}) {
  const run = vi.fn<FallbackOptions["run"]>();
  for (const candidate of candidates) {
    run.mockResolvedValueOnce(candidate);
  }
  return {
    ...(await runWithModelFallback({
      ...contractRunOptions,
      mergeExhaustedResult,
      ...overrides,
      run,
    })),
    run,
  };
}

function expectEmptyFinal(result: RunResult, optional: boolean) {
  expect(result.payloads).toBeUndefined();
  expect(result.meta.terminalReply).toEqual({ disposition: "empty" });
  expect(result.meta.finalAssistantVisibleText).toBe(optional ? "" : undefined);
  expect(result.meta.finalAssistantRawText).toBeUndefined();
}

function incompleteResult(
  text: string | undefined,
  message: string,
  meta: Partial<RunMeta> = {},
  error: Partial<NonNullable<RunMeta["error"]>> = {},
) {
  return createContractRunResult({
    payloads: text === undefined ? [] : [{ text, isError: true }],
    meta: {
      durationMs: 1,
      ...meta,
      error: { kind: "incomplete_turn", message, fallbackSafe: true, ...error },
    },
  });
}

function agentMeta(stage: "primary" | "fallback") {
  return {
    sessionId: `${stage}-session`,
    sessionFile: `/tmp/${stage}.jsonl`,
    provider: contract[`${stage}Provider`],
    model: contract[`${stage}Model`],
  };
}

function emptyResult({
  meta,
  ...fields
}: Partial<Omit<RunResult, "meta">> & { meta?: Partial<RunMeta> } = {}) {
  return createContractRunResult({
    ...fields,
    meta: { durationMs: 1, agentHarnessResultClassification: "empty", ...meta },
  });
}

describe("Outcome/fallback runtime contract - embedded runtime fallback classifier", () => {
  beforeAll(async () => {
    await runWithModelFallback({
      cfg: undefined,
      provider: contract.primaryProvider,
      model: contract.primaryModel,
      fallbacksOverride: [],
      run: vi.fn().mockResolvedValue(createContractRunResult({ meta: { durationMs: 1 } })),
      skipAuthProfileRuntime: true,
    });
  });

  it.each([
    ["optional", undefined, 1, 1],
    ["result-required", undefined, 1, 2],
    ["result-required", "empty", 3, 6],
    ["result-required", "reasoning-only", 3, 9],
    ["required", "empty", 3, 6],
  ] as const)(
    "settles an empty stop for %s replies with harness classification %s",
    async (expectation, classification, expectedModels, expectedRequests) => {
      const prompt = "The result is already incorporated. No new update.";
      const provenance = { kind: "inter_session" as const, sourceTool: "sessions_send" };
      const inputProvenance = expectation === "required" ? undefined : provenance;
      const optional = expectation === "optional";
      const user = { role: "user" as const, content: prompt, timestamp: 0 };
      const assistant = emptyAssistant({
        ...(classification === "reasoning-only"
          ? { content: [{ type: "thinking" as const, thinking: "checking" }] }
          : {}),
        stopReason: "stop",
        usage: createMockUsage(89, 4),
      });
      let modelRequests = 0;
      const run = vi.fn(async () => {
        const attempt = makeEmbeddedRunnerAttempt({
          assistantTexts: [],
          agentHarnessResultClassification: classification,
          messagesSnapshot: [
            inputProvenance ? applyInputProvenanceToUserMessage(user, inputProvenance) : user,
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
            inputProvenance,
            terminalReplyExpectation: expectation,
          },
        });
        for (;;) {
          modelRequests += 1;
          const terminal = await resolveEmbeddedRunTerminal(input);
          if (terminal.action === "complete") {
            expectEmptyFinal(terminal.result, optional);
            return terminal.result;
          }
        }
      });

      const result = await runWithModelFallback({
        ...contractRunOptions,
        model: "gpt-5.6-sol",
        fallbacksOverride: ["openai/gpt-5.6-terra", "openai/gpt-5.6-luna"],
        run,
      });

      expect(run).toHaveBeenCalledTimes(expectedModels);
      expect(modelRequests).toBe(expectedRequests);
      const fallbackExpected = expectation !== "optional" && classification !== undefined;
      expect(result.model).toBe(fallbackExpected ? "gpt-5.6-luna" : "gpt-5.6-sol");
      expect(result.attempts).toHaveLength(fallbackExpected ? 3 : 0);
      expect(result.result.meta.error?.kind).toBe(optional ? undefined : "incomplete_turn");
      expectEmptyFinal(result.result, optional);
      if (!result.result.meta.error) {
        return;
      }
      const notice = await resolveTerminalAgentRunFailurePayload({
        result: result.result,
        run: {
          messageChannel: "telegram",
          terminalReplyExpectation: expectation,
          inputProvenance,
        },
        visibleReplyDelivered: async () => false,
      });
      if (expectation === "required") {
        expect(result.outcome).toBe("exhausted");
        expect(notice).toMatchObject({
          text: "No answer was returned. Ask again if you still need one.",
          isError: true,
          isStatusNotice: true,
        });
        expect(getReplyPayloadMetadata(notice ?? {})?.assistantTranscriptOwned).toBe(true);
      } else {
        expect(notice).toBeUndefined();
      }
    },
  );

  it("keeps an internal missing-result notice private after a later provider candidate fails", async () => {
    const missing = incompleteResult(
      undefined,
      "No answer was returned. Ask again if you still need one.",
      {
        stopReason: "error",
        suppressErrorNotice: true,
        terminalReply: { disposition: "empty" },
      },
    );
    const provider = createContractRunResult({
      payloads: [{ isError: true, text: "HTTP 500: internal server error" }],
      meta: { durationMs: 2, stopReason: "error" },
    });
    const result = await runCandidates([missing, provider]);
    const terminal = buildRunEntryTerminal({
      result: result.result,
      outcome: resolveRunEntryTerminalOutcome({ result: result.result, fallbackExhausted: true }),
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
      runId: "internal-result-run",
      sessionId: "internal-result-session",
      requested: { provider: "external", model: "primary" },
    });
    expect(result.run).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe("exhausted");
    expect(result.result.meta).toMatchObject({ durationMs: 2, suppressErrorNotice: true });
    expect(result.result.meta.error).toBe(missing.meta.error);
    expect(result.attempts.at(-1)).toMatchObject({
      reason: "server_error",
      error: expect.stringContaining("HTTP 500: internal server error"),
    });
    expect(terminal.outcome.status).toBe("error");
    expect(terminal.metadata.suppressErrorNotice).toBe(true);
  });

  it.each([
    [false, undefined, false],
    [true, undefined, false],
    [true, false, false],
    [true, undefined, true],
  ] as const)(
    "preserves the preferred exhausted summary (richer=%s, suppress=%s, no fallback=%s)",
    async (richer, suppressErrorNotice, noFallback) => {
      const primary = incompleteResult(
        "Primary terminal summary",
        "Primary incomplete",
        richer
          ? {
              ...(suppressErrorNotice === undefined ? {} : { suppressErrorNotice }),
              agentMeta: agentMeta("primary"),
              terminalReply: { disposition: "silent" },
              toolSummary: { calls: 1, tools: ["web_fetch"] },
            }
          : {},
        richer ? { terminalPresentation: true } : {},
      );
      const winner = { provider: contract.fallbackProvider, model: contract.fallbackModel };
      const fallback = incompleteResult(
        richer ? "Generic fallback incomplete" : "Fallback terminal summary",
        "Fallback incomplete",
        richer
          ? {
              suppressErrorNotice: true,
              agentMeta: agentMeta("fallback"),
              executionTrace: {
                winnerProvider: winner.provider,
                winnerModel: winner.model,
                fallbackUsed: true,
                runner: "embedded",
                attempts: [{ ...winner, result: "success" }],
              },
            }
          : {},
      );
      const result = await runCandidates(
        noFallback ? [primary] : [primary, fallback],
        noFallback ? { fallbacksOverride: [] } : {},
      );
      expect(result).toMatchObject({
        outcome: "exhausted",
        ...(noFallback
          ? { provider: contract.primaryProvider, model: contract.primaryModel }
          : winner),
      });
      expect(result.attempts).toHaveLength(noFallback ? 1 : 2);
      expect(result.attempts[0]).toMatchObject({
        provider: contract.primaryProvider,
        model: contract.primaryModel,
        reason: "format",
        code: "incomplete_result",
      });
      if (noFallback) {
        expect(result.result).toBe(primary);
        expect(result.result.payloads).toEqual([
          { text: "Primary terminal summary", isError: true },
        ]);
        return;
      }
      if (!richer) {
        expect(result.result).toBe(fallback);
        return;
      }
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
    },
  );

  it("rethrows an unrecognized final failure instead of hiding it behind an earlier summary", async () => {
    const primary = incompleteResult("Primary terminal summary", "Primary incomplete");
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
  it.each<[string, Partial<Parameters<typeof classifyResult>[0]>]>([
    ["abort", { result: emptyResult({ meta: { aborted: true } }) }],
    ["media send", { result: emptyResult({ messagingToolSentMediaUrls: ["image.png"] }) }],
    [
      "target send",
      {
        result: emptyResult({
          messagingToolSentTargets: [{ tool: "message", provider: "slack", to: "channel-1" }],
        }),
      },
    ],
    ["cron add", { result: emptyResult({ successfulCronAdds: 1 }) }],
    ["direct block reply", { hasDirectlySentBlockReply: true }],
    ["block reply pipeline", { hasBlockReplyPipelineOutput: true }],
  ])("does not fallback after %s", (_name, options) => {
    expect(classifyResult({ ...contractRunOptions, result: emptyResult(), ...options })).toBeNull();
  });
});
