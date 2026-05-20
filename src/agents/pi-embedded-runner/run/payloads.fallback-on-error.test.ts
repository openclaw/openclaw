import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { buildPayloads } from "./payloads.test-helpers.js";

// Regression guards for tasks/openclaw/20260520-001 (luna repetition fix):
// when the previous assistant turn ended with stopReason === "error" (e.g.
// vLLM 400 context overflow), the runner must not emit the last successful
// assistant text as a fallback on the next turn. Doing so caused users to
// receive the same response twice in a row (see work-report 20260520-040).

describe("buildEmbeddedRunPayloads — fallback-on-error guard", () => {
  const SUCCESSFUL_PRIOR_ANSWER = "previously successful answer text";
  const VLLM_CONTEXT_OVERFLOW_RAW =
    "400 This model's maximum context length is 65536 tokens. However, you requested 70000 tokens.";

  const makeErroredAssistantWithPriorText = (): AssistantMessage =>
    makeAssistantMessageFixture({
      stopReason: "error",
      errorMessage: VLLM_CONTEXT_OVERFLOW_RAW,
      // The content array still carries the previous successful response text;
      // this is the exact shape that triggered the repetition bug — the
      // fallback path mined this content even though the turn errored.
      content: [{ type: "text", text: SUCCESSFUL_PRIOR_ANSWER }],
    });

  const makeStoppedAssistantWithText = (text: string): AssistantMessage =>
    makeAssistantMessageFixture({
      stopReason: "stop",
      errorMessage: undefined,
      content: [{ type: "text", text }],
    });

  it("T1: lastAssistant errored + no current-turn texts → does not re-emit prior assistant text", () => {
    const payloads = buildPayloads({
      assistantTexts: [],
      lastAssistant: makeErroredAssistantWithPriorText(),
    });

    // No payload should contain the previously successful answer; the only
    // emitted text should be the formatted error message (isError true).
    expect(payloads.some((p) => p.text === SUCCESSFUL_PRIOR_ANSWER)).toBe(false);
    expect(payloads.some((p) => p.text?.includes(SUCCESSFUL_PRIOR_ANSWER))).toBe(false);
    const errorPayloads = payloads.filter((p) => p.isError);
    expect(errorPayloads.length).toBeGreaterThan(0);
  });

  it("T2: lastAssistant did not error + no current-turn texts → existing fallback behavior preserved", () => {
    const payloads = buildPayloads({
      assistantTexts: [],
      lastAssistant: makeStoppedAssistantWithText("Hello from a clean run"),
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Hello from a clean run");
    expect(payloads[0]?.isError).toBeFalsy();
  });

  it("T3: lastAssistant errored + current-turn text present → current-turn text used, fallback bypassed", () => {
    const payloads = buildPayloads({
      assistantTexts: ["fresh current-turn answer"],
      lastAssistant: makeErroredAssistantWithPriorText(),
    });

    // Current-turn text must survive; prior successful text must not be re-emitted.
    expect(payloads.some((p) => p.text === "fresh current-turn answer")).toBe(true);
    expect(payloads.some((p) => p.text === SUCCESSFUL_PRIOR_ANSWER)).toBe(false);
  });
});
