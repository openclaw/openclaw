import { expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { classifyAgentExecResult } from "../../../commands/agent-exec-result.js";
import { toolAssistant } from "./settled-turn-fixtures.test-support.js";
import { prepareAttempt } from "./terminal-preparation.test-support.js";
import {
  resolveEmbeddedRunTerminal,
  resolveSettledTurnFinalizationRequest,
} from "./terminal-resolution.js";
import {
  expectComplete,
  makeTerminalInput,
  textAssistant,
} from "./terminal-resolution.test-support.js";

// mock-isolation: auth bookkeeping is unrelated to the terminal delivery contract.
vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

it.each([
  { output: "native", denialFirst: true },
  { output: "native", denialFirst: false },
  { output: "commentary" },
  { output: "toolUse" },
  { output: "delegated" },
  { output: "visible" },
  { output: "silent" },
])(
  "delivers the terminal denied-exec outcome (output=$output, denialFirst=$denialFirst)",
  async ({ output, denialFirst = true }) => {
    const commentary = output === "commentary" ? "I will check the command and file." : undefined;
    const toolCalls = toolAssistant(["denied", "bash"], ["sibling", "read"]);
    if (commentary) {
      toolCalls.content.unshift({ type: "text", text: commentary });
    }
    const results = [
      makeTextToolResult("denied", "bash", "Execution denied.", true, 0),
      makeTextToolResult("sibling", "read", "File contents.", false, 0),
    ];
    const answered = output === "visible" || output === "silent";
    const answerText =
      output === "silent" ? "NO_REPLY" : "The command was denied; the file was read successfully.";
    const assistant = answered
      ? textAssistant(answerText)
      : commentary
        ? textAssistant("")
        : output === "toolUse"
          ? toolCalls
          : undefined;
    const input = makeTerminalInput({
      assistant,
      attemptOverrides: {
        assistantTexts: answered ? [answerText] : commentary ? [commentary] : [],
        agentHarnessResultClassification: output === "native" ? "empty" : undefined,
        acceptedSessionSpawns:
          output === "delegated"
            ? [{ runId: "child-run", childSessionKey: "agent:main:subagent:child" }]
            : undefined,
        lastToolError: {
          toolName: "bash",
          error: "codex native tool blocked",
          executionStarted: false,
          mutatingAction: false,
        },
        toolMetas: [
          { toolName: "bash", toolCallId: "denied", isError: true, replaySafe: true },
          { toolName: "read", toolCallId: "sibling", isError: false, replaySafe: true },
        ],
        itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
        messagesSnapshot: [
          { role: "user", content: "Run the command and read the file.", timestamp: 0 },
          toolCalls,
          ...(denialFirst ? results : results.toReversed()),
          ...(assistant && (answered || commentary) ? [assistant] : []),
        ],
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      },
    });
    input.prepared = await prepareAttempt({
      runParams: input.runParams,
      attempt: input.attempt,
      currentAttemptCompletedAssistant: assistant,
      terminalState: input.terminalState,
    });

    const failureWarningText = input.prepared.payloads?.find((payload) => payload.isError)?.text;
    if (output === "native" || output === "commentary") {
      expect(
        resolveSettledTurnFinalizationRequest({
          ...input,
          payloadsWithToolMedia: input.prepared.payloadsWithToolMedia,
          hasTerminalToolPresentation: false,
          settledTurnFinalizationAvailable: true,
          replyDeliveryState: input.prepared.replyDeliveryState,
        }),
      ).toBeNull();
    }
    const resolved = await resolveEmbeddedRunTerminal(input);

    expectComplete(resolved);
    expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
    expect(classifyAgentExecResult(resolved.result).status).toBe(answered ? "ok" : "error");
    if (answered) {
      expect(resolved.result.meta.error).toBeUndefined();
      if (output === "silent") {
        expect(resolved.result.meta.terminalReply).toEqual({ disposition: "silent" });
        expect(resolved.result.payloads).toBeUndefined();
      } else {
        expect(resolved.result.payloads?.map((payload) => payload.text)).toEqual([answerText]);
      }
    } else {
      expect(failureWarningText).toContain("blocked");
      expect(resolved.result.payloads).toMatchObject([{ text: failureWarningText, isError: true }]);
      if (output === "delegated") {
        expect(resolved.result.meta.error).toBeUndefined();
      } else {
        expect(resolved.result.meta.error).toMatchObject({
          kind: "incomplete_turn",
          message: failureWarningText,
        });
        expect(resolved.result.meta.stopReason).toBe("error");
      }
    }
  },
);
