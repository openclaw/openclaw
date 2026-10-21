import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import {
  expectComplete,
  makeTerminalInput,
  textAssistant,
} from "./terminal-resolution.test-support.js";

// mock-isolation: Terminal recovery must not publish auth success to persistent stores.
vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

const toolCallText =
  '```json\n{"name":"write","arguments":{"path":"proof.txt","content":"OK"}}\n```';

function makeTextCallInput(
  overrides: Parameters<typeof makeEmbeddedRunnerAttempt>[0] = {},
  text = toolCallText,
) {
  const assistant = textAssistant(text, { stopReason: "stop" });
  return makeTerminalInput({
    attempt: makeEmbeddedRunnerAttempt({
      assistantTexts: [text],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      textToolCallAttempt: true,
      ...overrides,
    }),
    payloadsWithToolMedia: [{ text }],
  });
}

describe("terminal resolution for a tool call written as text", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { toolName: "read", replaySafe: true, action: "retry" },
    { toolName: "write", replaySafe: false, action: "complete" },
  ])(
    "preserves retry safety after an earlier $toolName",
    async ({ toolName, replaySafe, action }) => {
      const input = makeTextCallInput({
        toolMetas: [{ toolName, replaySafe, isError: false }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        replayMetadata: { replaySafe, hadPotentialSideEffects: !replaySafe },
      });
      const result = await resolveEmbeddedRunTerminal(input);
      expect(result.action).toBe(action);
      expect(input.sessionPromptState.activateInternalPrompt).toHaveBeenCalledTimes(
        replaySafe ? 1 : 0,
      );
      if (result.action === "complete") {
        expect(result.result.meta.error).toMatchObject({ kind: "incomplete_turn" });
        expect(result.result.payloads?.[0]?.text).toContain("No tool ran for that call");
        expect(result.result.payloads?.[0]?.text).toContain("please verify before retrying");
      }
    },
  );

  it("warns about cumulative side effects when the text retry is exhausted", async () => {
    const input = makeTextCallInput();
    input.retryState.textToolCallAttempts = 1;
    input.replayState.hadPotentialSideEffects = true;
    const result = await resolveEmbeddedRunTerminal(input);
    expect(result.action).toBe("complete");
    expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
    if (result.action === "complete") {
      expect(result.result.payloads?.[0]?.text).toContain("No tool ran for that call");
      expect(result.result.payloads?.[0]?.text).toContain("please verify before retrying");
    }
  });

  it("nudges once, then returns a visible failure instead of successful JSON text", async () => {
    const input = makeTextCallInput();
    input.retryState.emptyResponseAttempts = 1;
    await expect(resolveEmbeddedRunTerminal(input)).resolves.toEqual({ action: "retry" });
    expect(input.sessionPromptState.activateInternalPrompt).toHaveBeenCalledWith(
      expect.stringContaining("call the tool natively"),
    );
    expect(input.retryState.textToolCallAttempts).toBe(1);

    const repeated = await resolveEmbeddedRunTerminal(input);
    expectComplete(repeated);
    expect(repeated.result.meta.error).toMatchObject({ kind: "incomplete_turn" });
    expect(repeated.result.payloads).toEqual([
      {
        text: "⚠️ The model wrote a tool call as text instead of calling the tool. No tool ran for that call. Please try again or use a model with native tool calling.",
        isError: true,
      },
    ]);
  });

  it("accepts a real answer after the corrective retry", async () => {
    const input = makeTextCallInput();
    await resolveEmbeddedRunTerminal(input);
    const answer = "Created and read proof.txt: OK";
    const recovery = makeTextCallInput(
      {
        lastAssistant: undefined,
        textToolCallAttempt: false,
        toolMetas: [{ toolName: "write", isError: false, replaySafe: false }],
        replayMetadata: { replaySafe: false, hadPotentialSideEffects: true },
      },
      answer,
    );
    recovery.retryState = { ...input.retryState };
    const recovered = await resolveEmbeddedRunTerminal(recovery);
    expectComplete(recovered);
    expect(recovered.result.meta.error).toBeUndefined();
    expect(recovered.result.payloads).toEqual([{ text: answer }]);
  });
});
