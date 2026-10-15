import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";

// mock-isolation: Terminal recovery must not publish auth success to persistent stores.
vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

const text = '```json\n{"name":"write","arguments":{"path":"proof.txt","content":"OK"}}\n```';

function makeTextCallInput(overrides: Parameters<typeof makeEmbeddedRunnerAttempt>[0] = {}) {
  const assistant = buildEmbeddedRunnerAssistant({
    stopReason: "stop",
    content: [{ type: "text", text }],
  });
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
    expect(repeated.action).toBe("complete");
    if (repeated.action !== "complete") {
      throw new Error("expected bounded terminal failure");
    }
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
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "stop",
      content: [{ type: "text", text: "Created and read proof.txt: OK" }],
    });
    const recovered = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        retryState: input.retryState,
        attempt: makeEmbeddedRunnerAttempt({
          assistantTexts: ["Created and read proof.txt: OK"],
          currentAttemptAssistant: assistant,
          toolMetas: [{ toolName: "write", isError: false, replaySafe: false }],
          replayMetadata: { replaySafe: false, hadPotentialSideEffects: true },
        }),
        payloadsWithToolMedia: [{ text: "Created and read proof.txt: OK" }],
      }),
    );
    expect(recovered.action).toBe("complete");
    if (recovered.action !== "complete") {
      throw new Error("expected normal answer");
    }
    expect(recovered.result.meta.error).toBeUndefined();
    expect(recovered.result.payloads).toEqual([{ text: "Created and read proof.txt: OK" }]);
  });
});
