import { describe, expect, it } from "vitest";
import { isLikelyInterimExecutionMessage } from "./interim-execution.js";

describe("isLikelyInterimExecutionMessage", () => {
  it("accepts short acknowledgement placeholders", () => {
    expect(isLikelyInterimExecutionMessage("on it")).toBe(true);
    expect(isLikelyInterimExecutionMessage("working on it, it'll auto-announce when done")).toBe(
      true,
    );
  });

  it("rejects substantive final content", () => {
    expect(
      isLikelyInterimExecutionMessage("Here are the final results and the next concrete steps."),
    ).toBe(false);
    expect(isLikelyInterimExecutionMessage("The total should be about $40.")).toBe(false);
    expect(isLikelyInterimExecutionMessage("You should have your summary ready by tomorrow.")).toBe(
      false,
    );
  });

  it("rejects empty text", () => {
    expect(isLikelyInterimExecutionMessage("")).toBe(false);
    expect(isLikelyInterimExecutionMessage("   ")).toBe(false);
  });
});
