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
      textToolCallName: overrides.textToolCallAttempt === false ? undefined : "write",
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

it.each([true, false])(
  "does not accept text calls in scheduled runs (replay safe: %s)",
  async (replaySafe) => {
    const input = makeTextCallInput({
      toolMetas: [{ toolName: replaySafe ? "read" : "write", replaySafe, isError: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      replayMetadata: { replaySafe, hadPotentialSideEffects: !replaySafe },
    });
    input.runParams.trigger = "cron";
    input.runParams.terminalReplyExpectation = "optional";

    const first = await resolveEmbeddedRunTerminal(input);
    expect(first.action).toBe(replaySafe ? "retry" : "complete");
    expect(input.sessionPromptState.activateInternalPrompt).toHaveBeenCalledTimes(
      Number(replaySafe),
    );
    const terminal = replaySafe ? await resolveEmbeddedRunTerminal(input) : first;
    expectComplete(terminal);
    expect(terminal.result.meta.error).toMatchObject({ kind: "incomplete_turn" });
    expect(terminal.result.payloads?.[0]?.text).toContain("No tool ran for that call");
  },
);

it("rejects a corrective answer that still made no native call", async () => {
  const input = makeTextCallInput();
  input.runParams.terminalReplyExpectation = "optional";
  await resolveEmbeddedRunTerminal(input);
  const recovery = makeTextCallInput({ textToolCallAttempt: false }, "done");
  recovery.runParams.terminalReplyExpectation = "optional";
  recovery.retryState = input.retryState;

  const result = await resolveEmbeddedRunTerminal(recovery);
  expectComplete(result);
  expect(result.result.meta.error).toMatchObject({ kind: "incomplete_turn" });
  expect(result.result.payloads?.[0]?.text).toContain("No tool ran for that call");
});

it.each(["NO_REPLY", "unrelated read"])(
  "does not settle a pending write with %s",
  async (reply) => {
    const input = makeTextCallInput();
    input.runParams.trigger = "cron";
    input.runParams.terminalReplyExpectation = "optional";
    await resolveEmbeddedRunTerminal(input);
    const recovery = makeTextCallInput(
      {
        textToolCallAttempt: false,
        toolMetas:
          reply === "unrelated read"
            ? [{ toolName: "read", isError: false, replaySafe: true }]
            : [],
      },
      reply === "NO_REPLY" ? reply : "done",
    );
    recovery.runParams.trigger = "cron";
    recovery.runParams.terminalReplyExpectation = "optional";
    recovery.retryState = input.retryState;

    const result = await resolveEmbeddedRunTerminal(recovery);
    expectComplete(result);
    expect(result.result.meta.error).toMatchObject({ kind: "incomplete_turn" });
    expect(result.result.payloads?.[0]?.text).toContain("No tool ran for that call");
  },
);

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
