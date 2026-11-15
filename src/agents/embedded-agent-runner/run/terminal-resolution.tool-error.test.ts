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
  { output: "native", denialFirst: false, providerFailure: "Usage limit; try again at noon." },
  { output: "commentary" },
  { output: "toolUse" },
  { output: "delegated" },
  { output: "visible" },
  { output: "silent" },
])(
  "delivers the terminal denied-exec outcome (output=$output, denialFirst=$denialFirst)",
  async ({ output, denialFirst = true, providerFailure }) => {
    const commentary = output === "commentary" ? "I will check the command and file." : undefined;
    const toolCalls = toolAssistant(["denied", "bash"], ["sibling", "read"]);
    if (commentary) {
      toolCalls.content.unshift({ type: "text", text: commentary });
    }
    const results = [
      makeTextToolResult("denied", "bash", "Execution denied.", true, 0),
      makeTextToolResult("sibling", "read", "File contents.", false, 0),
    ];
    const silent = output === "silent";
    const answered = output === "visible" || silent;
    const answerText = silent
      ? "NO_REPLY"
      : "The command was denied; the file was read successfully.";
    const warningText = `⚠️ Bash ${providerFailure ? "failed" : "blocked"}`;
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
        terminal: providerFailure
          ? { kind: "failed", source: "prompt", error: providerFailure }
          : { kind: "ok" },
        agentHarnessResultClassification: output === "native" ? "empty" : undefined,
        acceptedSessionSpawns:
          output === "delegated"
            ? [{ runId: "child-run", childSessionKey: "agent:main:subagent:child" }]
            : undefined,
        lastToolError: {
          toolName: "bash",
          error: "codex native tool blocked",
          executionStarted: Boolean(providerFailure),
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
      ...input,
      currentAttemptCompletedAssistant: assistant,
    });
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
    const { payloads } = resolved.result;
    expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
    expect(classifyAgentExecResult(resolved.result).status).toBe(answered ? "ok" : "error");
    if (answered) {
      expect(resolved.result.meta.error).toBeUndefined();
      expect(payloads?.map(({ text }) => text)).toEqual(silent ? undefined : [answerText]);
      if (silent) {
        expect(resolved.result.meta.terminalReply).toEqual({ disposition: "silent" });
      }
    } else {
      const expected = [providerFailure && `⚠️ ${providerFailure}`, warningText].filter(Boolean);
      expect(payloads).toMatchObject(expected.map((text) => ({ text, isError: true })));
      if (output === "delegated") {
        expect(resolved.result.meta.error).toBeUndefined();
      } else {
        expect(resolved.result.meta.error).toMatchObject({
          kind: "incomplete_turn",
          message: providerFailure ?? warningText,
        });
        expect(resolved.result.meta.stopReason).toBe("error");
      }
    }
  },
);
