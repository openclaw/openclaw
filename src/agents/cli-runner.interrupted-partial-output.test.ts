/** Tests caller-boundary settlement for interrupted CLI turns with partial output. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliSessionBinding } from "../config/sessions.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runPreparedCliAgent } from "./cli-runner.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";
import * as cliTranscript from "./command/attempt-execution.helpers.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunSupersededAbortError,
} from "./run-termination.js";

const { executePreparedCliRunMock } = vi.hoisted(() => ({
  executePreparedCliRunMock: vi.fn(),
}));

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executePreparedCliRunMock,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

const getGlobalHookRunnerMock = vi.mocked(getGlobalHookRunner);

describe("runPreparedCliAgent interrupted partial output", () => {
  beforeEach(() => {
    executePreparedCliRunMock.mockReset();
    getGlobalHookRunnerMock.mockReset();
  });

  it.each([
    {
      reason: "aborted" as const,
      expectedMeta: { stopReason: "aborted" },
    },
    {
      reason: "timeout" as const,
      expectedMeta: { stopReason: "timeout", timeoutPhase: "provider" },
    },
  ])(
    "retains partial text while settling $reason as non-success",
    async ({ reason, expectedMeta }) => {
      const onSuccessfulAuthBinding = vi.fn();
      const hookRunner = {
        hasHooks: vi.fn((hookName: string) => hookName === "agent_end"),
        runAgentEnd: vi.fn(async (_event: { messages?: unknown[] }) => undefined),
      };
      getGlobalHookRunnerMock.mockReturnValue(hookRunner as never);
      executePreparedCliRunMock.mockResolvedValue({
        text: "partial answer",
        rawText: "partial answer",
        sessionId: "interrupted-native-session",
        terminalInterruption: { reason },
      });
      const context = buildPreparedCliRunContext({ onSuccessfulAuthBinding });
      context.reusableCliSession = { mode: "reuse", sessionId: "interrupted-native-session" };

      const result = await runPreparedCliAgent(context);

      expect(result.payloads).toEqual([{ text: "partial answer" }]);
      expect(result.meta).toMatchObject({
        aborted: true,
        providerStarted: true,
        ...expectedMeta,
        completion: {
          finishReason: reason,
          stopReason: reason,
          refusal: false,
        },
        executionTrace: {
          attempts: [
            {
              provider: "claude-cli",
              model: "sonnet",
              result: reason,
              reason: `CLI turn ${reason} after partial output`,
            },
          ],
        },
        agentMeta: {
          sessionId: "",
          clearCliSessionBinding: true,
        },
      });
      expect(onSuccessfulAuthBinding).not.toHaveBeenCalled();
      expect(hookRunner.runAgentEnd).toHaveBeenCalledOnce();
      const agentEndEvent = hookRunner.runAgentEnd.mock.calls[0]?.[0];
      expect(agentEndEvent).toMatchObject({
        success: false,
        error: `CLI turn ${reason} after partial output`,
      });
      expect(agentEndEvent?.messages).toEqual([
        expect.objectContaining({ role: "user", content: "hi" }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "partial answer" }],
          stopReason: "aborted",
        }),
      ]);
    },
  );
});

describe("runPreparedCliAgent directly stopped first turn", () => {
  const transcriptProbe = vi.fn(async (_params: { sessionId?: string }) => true);

  beforeEach(() => {
    executePreparedCliRunMock.mockReset();
    getGlobalHookRunnerMock.mockReset();
    transcriptProbe.mockReset().mockResolvedValue(true);
    vi.spyOn(cliTranscript, "claudeCliSessionTranscriptHasContent").mockImplementation(
      transcriptProbe,
    );
  });

  afterEach(() => {
    vi.mocked(cliTranscript.claudeCliSessionTranscriptHasContent).mockRestore();
  });

  function stoppedRun(params: {
    abort?: Error;
    reusableSessionId?: string;
    persist?: () => Promise<void>;
  }) {
    executePreparedCliRunMock.mockResolvedValue({
      text: "partial answer",
      rawText: "partial answer",
      sessionId: "stopped-first-session",
      terminalInterruption: { reason: "aborted" },
    });
    const persistStoppedFirstCliSession = vi.fn<(binding: CliSessionBinding) => Promise<void>>(
      params.persist ?? (async () => {}),
    );
    const context = buildPreparedCliRunContext();
    context.params.persistStoppedFirstCliSession = persistStoppedFirstCliSession;
    if (params.reusableSessionId) {
      context.reusableCliSession = { mode: "reuse", sessionId: params.reusableSessionId };
    }
    const abort = params.abort ?? createAgentRunDirectAbortError();
    context.params.assertCurrent = () => {
      throw abort;
    };
    return { abort, context, persistStoppedFirstCliSession };
  }

  it("binds the flushed native session and rethrows the stop unsettled", async () => {
    const { abort, context, persistStoppedFirstCliSession } = stoppedRun({});

    await expect(runPreparedCliAgent(context)).rejects.toBe(abort);

    expect(transcriptProbe).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "stopped-first-session" }),
    );
    expect(persistStoppedFirstCliSession).toHaveBeenCalledOnce();
    expect(persistStoppedFirstCliSession.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "stopped-first-session",
    });
  });

  it.each([
    { name: "a superseded run", abort: createAgentRunSupersededAbortError() },
    { name: "a resumed turn", reusableSessionId: "established-session" },
    { name: "an unflushed transcript", unflushed: true },
  ])("binds nothing for $name", async ({ abort, reusableSessionId, unflushed }) => {
    if (unflushed) {
      transcriptProbe.mockResolvedValue(false);
    }
    const run = stoppedRun({ abort, reusableSessionId });

    await expect(runPreparedCliAgent(run.context)).rejects.toBe(run.abort);

    expect(run.persistStoppedFirstCliSession).not.toHaveBeenCalled();
  });

  it("keeps the stop when the binding write is refused", async () => {
    const { abort, context, persistStoppedFirstCliSession } = stoppedRun({
      persist: async () => {
        throw new Error("settlement closed");
      },
    });

    await expect(runPreparedCliAgent(context)).rejects.toBe(abort);
    expect(persistStoppedFirstCliSession).toHaveBeenCalledOnce();
  });
});
