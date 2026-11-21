import { afterEach, describe, expect, it } from "vitest";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import { appendOutput } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { maybeNotifyOnExit } from "./bash-tools.exec-notify.js";
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

  it("returns the input unchanged when no non-empty line exists", () => {
    const raw = "  \n\t \n";
    expect(selectExecCompletionContent(raw)).toBe(raw);
    // The caller trims before calling; the trimmed form is what reaches the no-output branch.
    expect(selectExecCompletionContent(raw.trim())).toBe("");
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

describe("wake owner completion content", () => {
  afterEach(() => resetSystemEventsForTest());

  it("surfaces the stripped marker summary of a truncated oversized tail", async () => {
    const sessionKey = "agent:main:subagent:completion-marker";
    const output = "x".repeat(2_000) + "\nOK: all done, 3 files";
    const process = createProcessSessionFixture({
      id: "wake-marker",
      backgrounded: true,
      maxOutputChars: 2_000,
    });
    Object.assign(process, { sessionKey, exitCode: 0 });
    appendOutput(process, "stdout", output);
    await maybeNotifyOnExit(process, "completed", true);
    const [wake] = peekSystemEvents(sessionKey);
    expect(wake).toContain("all done, 3 files");
    expect(wake).not.toContain("OK:");
    expect(wake).toContain("last 2000 of 2022 output chars");
  });

  it("keeps the full tail when the output fits the retained window", async () => {
    const sessionKey = "agent:main:subagent:completion-fit";
    const output = "line one\nline two\nlast line";
    const process = createProcessSessionFixture({ id: "wake-fit", backgrounded: true });
    Object.assign(process, { sessionKey, exitCode: 0 });
    appendOutput(process, "stdout", output);
    await maybeNotifyOnExit(process, "completed", true);
    const [wake] = peekSystemEvents(sessionKey);
    expect(wake).toContain("line one");
    expect(wake).toContain("line two");
    expect(wake).toContain("last line");
    expect(wake).not.toContain("output chars (process log");
  });
});
