import { describe, expect, it } from "vitest";
import { selectExecCompletionContent } from "./bash-tools.exec-output.js";

describe("selectExecCompletionContent", () => {
  it("uses the last non-empty line instead of the retained tail", () => {
    expect(selectExecCompletionContent("line one\nline two\nlast line")).toBe("last line");
  });

  it("ignores trailing blank lines when choosing the last line", () => {
    expect(selectExecCompletionContent("first\nsecond\n\n  \n")).toBe("second");
  });

  it("uses the summary after an OK: marker as the content", () => {
    expect(selectExecCompletionContent("work...\nOK: all done, 3 files")).toBe("all done, 3 files");
  });

  it("uses the summary after an ERR: marker as the content", () => {
    expect(selectExecCompletionContent("work...\nERR: failed with code 3")).toBe("failed with code 3");
  });

  it("keeps a marker line whose summary is empty", () => {
    expect(selectExecCompletionContent("work...\nOK:  ")).toBe("OK:");
  });

  it("falls back to the trimmed tail when the output is empty", () => {
    expect(selectExecCompletionContent("")).toBe("");
  });

  it("falls back to the trimmed tail when it is only whitespace", () => {
    expect(selectExecCompletionContent("  \n\t \n")).toBe("");
  });

  it("trims a last line longer than the window the same way the tail is capped", () => {
    const line = `head ${"x".repeat(5000)}END`;
    expect(selectExecCompletionContent(`first\n${line}`)).toBe("x".repeat(1997) + "END");
  });

  it("falls back to the trimmed tail when the last line is a JSON closing bracket", () => {
    const blob = `step 1\n{\n  "a": 1,\n  "b": 2\n}`;
    expect(selectExecCompletionContent(blob)).toBe(blob);
  });

  it("falls back to the trimmed tail when the last line is an array closing bracket", () => {
    const blob = "log line\n[\n  1,\n  2\n]";
    expect(selectExecCompletionContent(blob)).toBe(blob);
  });
});
