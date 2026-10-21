import { expect, it, vi } from "vitest";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import {
  assistantAttempt,
  expectComplete,
  makeTerminalInput,
  textAssistant,
} from "./terminal-resolution.test-support.js";

// mock-isolation: Terminal recovery must not publish auth success to persistent stores.
vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

const toolCallText = '```json\n{"name":"write","arguments":{"path":"proof.txt"}}\n```';

type AttemptOverrides = Parameters<typeof assistantAttempt>[1];
function makeTextCallInput(overrides: AttemptOverrides = {}, text = toolCallText) {
  return makeTerminalInput({
    assistant: textAssistant(text, { stopReason: "stop" }),
    attemptOverrides: {
      assistantTexts: [text],
      textToolCallAttempt: true,
      ...overrides,
    },
    payloadsWithToolMedia: [{ text }],
  });
}

it.each([
  { toolName: "read", replaySafe: true, exhausted: false },
  { toolName: "write", replaySafe: false, exhausted: false },
  { toolName: "none (exhausted retry)", replaySafe: true, exhausted: true },
])("preserves retry safety with $toolName", async ({ toolName, replaySafe, exhausted }) => {
  const count = exhausted ? 0 : 1;
  const input = makeTextCallInput({
    toolMetas: exhausted ? [] : [{ toolName, replaySafe, isError: false }],
    itemLifecycle: { startedCount: count, completedCount: count, activeCount: 0 },
    replayMetadata: { replaySafe, hadPotentialSideEffects: !replaySafe },
  });
  if (exhausted) {
    input.retryState.textToolCallAttempts = 1;
    input.replayState.hadPotentialSideEffects = true;
  }
  const retries = replaySafe && !exhausted;
  const result = await resolveEmbeddedRunTerminal(input);
  expect(result.action).toBe(retries ? "retry" : "complete");
  expect(input.sessionPromptState.activateInternalPrompt).toHaveBeenCalledTimes(Number(retries));
  if (result.action === "complete") {
    expect(result.result.meta.error).toMatchObject({ kind: "incomplete_turn" });
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
  const failureText =
    "⚠️ The model wrote a tool call as text instead of calling the tool. No tool ran for that call. Please try again or use a model with native tool calling.";
  expect(repeated.result.payloads).toEqual([{ text: failureText, isError: true }]);
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
