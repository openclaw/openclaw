import { describe, expect, it } from "vitest";
import { hasAgentHarnessCompletedAnswer } from "./projection-settlement.js";

describe("completed native answer eligibility", () => {
  it.each(["The completed answer.", "NO_REPLY", " \nNO_REPLY\t"])(
    "accepts a completed error-free answer: %j",
    (text) => {
      expect(hasAgentHarnessCompletedAnswer({ status: "completed", error: null, text })).toBe(true);
    },
  );

  it.each([
    { status: "failed", error: null, text: "Earlier answer." },
    { status: "cancelled", error: null, text: "Earlier answer." },
    { status: "interrupted", error: null, text: "Earlier answer." },
    { status: "in_progress", error: null, text: "Partial answer." },
    { status: undefined, error: null, text: "Unconfirmed answer." },
    { status: "completed", error: new Error("Native failure"), text: "Earlier answer." },
    { status: "completed", error: undefined, text: "Unconfirmed answer." },
    { status: "completed", error: null, text: undefined },
    { status: "completed", error: null, text: "" },
    { status: "completed", error: null, text: " \n\t" },
  ])("rejects incomplete or unsuccessful native evidence: %j", (evidence) => {
    expect(hasAgentHarnessCompletedAnswer(evidence)).toBe(false);
  });
});
