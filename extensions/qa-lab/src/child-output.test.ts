// Qa Lab tests cover child output byte caps.
import { describe, expect, it } from "vitest";
import {
  appendQaChildOutput,
  appendQaChildOutputTail,
  createQaChildOutputCapture,
  createQaChildOutputTail,
  formatQaChildOutputTail,
  readQaChildOutput,
} from "./child-output.js";

describe("qa child output", () => {
  it("keeps capped stdout UTF-8 safe when the byte cap splits a code point", () => {
    const text = "ok \u{1f600} done";
    const capture = createQaChildOutputCapture(Buffer.byteLength("ok \u{1f600}", "utf8") - 1);

    appendQaChildOutput(capture, Buffer.from(text, "utf8"));

    expect(readQaChildOutput(capture)).toBe("ok ");
  });

  it("keeps stderr tails UTF-8 safe when the retained tail starts inside a code point", () => {
    const tail = createQaChildOutputTail(Buffer.byteLength("\u{1f600}tail", "utf8") - 1);

    appendQaChildOutputTail(tail, Buffer.from("prefix \u{1f600}tail", "utf8"));

    expect(formatQaChildOutputTail(tail, "stderr")).toBe(
      "[stderr truncated to last 7 bytes]\ntail",
    );
  });
});
