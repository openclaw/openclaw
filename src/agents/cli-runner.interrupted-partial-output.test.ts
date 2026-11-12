import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliSessionBinding } from "../config/sessions.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runCliAgent, runPreparedCliAgent } from "./cli-runner.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";
import * as cliPreparation from "./cli-runner/prepare.runtime.js";
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
const partialText = "partial answer";
const sessionId = "stopped-first-session";
const partialOutput = (reason: "aborted" | "timeout") => ({
  text: partialText,
  rawText: partialText,
  sessionId,
  terminalInterruption: { reason },
});

beforeEach(() => {
  executePreparedCliRunMock.mockReset();
  getGlobalHookRunnerMock.mockReset();
});

describe("runPreparedCliAgent interrupted partial output", () => {
  it.each(["aborted", "timeout"] as const)(
    "retains partial text while settling %s as non-success",
    async (reason) => {
      const onSuccessfulAuthBinding = vi.fn();
      const hookRunner = {
        hasHooks: vi.fn((hookName: string) => hookName === "agent_end"),
        runAgentEnd: vi.fn(async (_event: { messages?: unknown[] }) => undefined),
      };
      getGlobalHookRunnerMock.mockReturnValue(hookRunner as never);
      executePreparedCliRunMock.mockResolvedValue(partialOutput(reason));
      const context = buildPreparedCliRunContext({ onSuccessfulAuthBinding });
      context.reusableCliSession = { mode: "reuse", sessionId };

      const result = await runPreparedCliAgent(context);

      expect(result.payloads).toEqual([{ text: partialText }]);
      expect(result.meta).toMatchObject({
        aborted: true,
        providerStarted: true,
        stopReason: reason,
        ...(reason === "timeout" ? { timeoutPhase: "provider" } : {}),
        completion: { finishReason: reason, stopReason: reason, refusal: false },
        executionTrace: {
          attempts: [{ provider: "claude-cli", model: "sonnet", result: reason }],
        },
        agentMeta: { sessionId: "", clearCliSessionBinding: true },
      });
      expect(onSuccessfulAuthBinding).not.toHaveBeenCalled();
      expect(hookRunner.runAgentEnd).toHaveBeenCalledOnce();
      expect(hookRunner.runAgentEnd.mock.calls[0]?.[0]).toMatchObject({
        success: false,
        error: `CLI turn ${reason} after partial output`,
        messages: [
          expect.objectContaining({ role: "user", content: "hi" }),
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: partialText }],
            stopReason: "aborted",
          }),
        ],
      });
    },
  );
});

describe("runPreparedCliAgent directly stopped first turn", () => {
  const transcriptProbe = vi.fn(async (_params: { sessionId?: string }) => true);

  beforeEach(() => {
    transcriptProbe.mockReset().mockResolvedValue(true);
    vi.spyOn(cliTranscript, "claudeCliSessionTranscriptHasContent").mockImplementation(
      transcriptProbe,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    { name: "a flushed first turn", bind: true },
    { name: "a refused binding write", bind: true, refused: true },
    { name: "a superseded run", abort: createAgentRunSupersededAbortError() },
    { name: "a resumed turn", reusableSessionId: "established-session" },
    { name: "an unflushed transcript", unflushed: true },
    { name: "a run without operator model authority", bind: true, noOperator: true },
  ])(
    "keeps the stop unsettled for $name",
    async ({ bind, refused, abort, reusableSessionId, unflushed, noOperator }) => {
      transcriptProbe.mockResolvedValue(!unflushed);
      const reason = abort ?? createAgentRunDirectAbortError();
      const stop = new AbortController();
      const persist = vi.fn(async (_binding: CliSessionBinding) => {
        if (refused) {
          throw new Error("settlement closed");
        }
      });
      const context = buildPreparedCliRunContext();
      context.params.persistStoppedFirstCliSession = persist;
      context.params.abortSignal = stop.signal;
      context.params.assertCurrent = noOperator
        ? undefined
        : () => {
            throw reason;
          };
      if (reusableSessionId) {
        context.reusableCliSession = { mode: "reuse", sessionId: reusableSessionId };
      }
      if (noOperator) {
        vi.spyOn(cliPreparation, "prepareCliRunContext").mockImplementation(async (params) => ({
          ...context,
          params: { ...params, admittedRunContext: context.params.admittedRunContext },
        }));
      }
      executePreparedCliRunMock.mockImplementation(async () => {
        stop.abort(reason);
        return partialOutput("aborted");
      });
      const run = noOperator ? runCliAgent(context.params) : runPreparedCliAgent(context);
      await expect(run).rejects.toBe(reason);
      expect(persist).toHaveBeenCalledTimes(bind ? 1 : 0);
      if (bind) {
        expect(transcriptProbe).toHaveBeenCalledWith(expect.objectContaining({ sessionId }));
        expect(persist.mock.calls[0]?.[0]).toMatchObject({ sessionId });
      }
    },
  );
});
