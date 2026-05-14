import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

function emptyFinalAfterToolsAttempt(provider: string, model: string): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    assistantTexts: [],
    toolMetas: [{ toolName: "exec", meta: "echo ok" }],
    itemLifecycle: {
      startedCount: 4,
      completedCount: 4,
      activeCount: 0,
    },
    lastAssistant: {
      stopReason: "stop",
      provider,
      model,
      content: [],
      usage: { input: 100, output: 0, totalTokens: 100 },
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
  });
}

function successAttempt(provider: string, model: string): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    assistantTexts: ["Done."],
    lastAssistant: {
      stopReason: "stop",
      provider,
      model,
      content: [{ type: "text", text: "Done." }],
      usage: { input: 100, output: 5, totalTokens: 105 },
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
  });
}

describe("runEmbeddedPiAgent empty-final continuation after completed tools", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  it("runs exactly one no-tool continuation instead of surfacing the side-effect warning", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      emptyFinalAfterToolsAttempt("openai-codex", "gpt-5.5"),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(successAttempt("openai-codex", "gpt-5.5"));

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai-codex",
      model: "gpt-5.5",
      runId: "run-empty-final-after-tools-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondAttemptParams = mockedRunEmbeddedAttempt.mock.calls[1]?.[0] as {
      prompt?: string;
      disableTools?: boolean;
    };
    expect(secondAttemptParams.disableTools).toBe(true);
    expect(secondAttemptParams.prompt).toContain(
      "The previous attempt completed tool calls but produced no user-visible answer",
    );
    expect(result.payloads).toBeUndefined();
  });

  it("surfaces the existing incomplete-turn warning if the no-tool continuation is empty too", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      emptyFinalAfterToolsAttempt("openai-codex", "gpt-5.5"),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      emptyFinalAfterToolsAttempt("openai-codex", "gpt-5.5"),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai-codex",
      model: "gpt-5.5",
      runId: "run-empty-final-after-tools-continuation-exhausted",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Agent couldn't generate a response");
  });
});
