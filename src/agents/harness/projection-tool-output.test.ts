import { describe, expect, it } from "vitest";
import { formatNativeToolOutput, NativeToolOutputAccumulator } from "./projection-tool-output.js";

describe("native tool output accumulation", () => {
  it("keeps streamed command output UTF-16 safe at the transcript limit", () => {
    const output = new NativeToolOutputAccumulator("Codex");
    const prefix = "a".repeat(9_886);
    output.append("cmd-utf16-streamed", `${prefix}😀${"a".repeat(400)}`);
    const item = output.append("cmd-utf16-streamed", "must not resurrect a split surrogate");
    expect(item.text).not.toMatch(/[\uD800-\uDFFF]/);
    expect(item.text).toContain("OpenClaw truncated Codex native tool output");
    expect(item.text).toContain("showing 10000");
  });

  it("keeps streaming after output text includes the truncation notice prefix", () => {
    const output = new NativeToolOutputAccumulator("Codex");
    const userOutputWithNotice =
      "...(OpenClaw truncated Codex native tool output is a literal line from the process)\n";
    output.append("cmd-notice-prefix", userOutputWithNotice);
    const item = output.append("cmd-notice-prefix", "second line must survive\n");
    expect(item.text).toBe(`${userOutputWithNotice}second line must survive\n`);
  });

  it("does not parse user output as a prior truncation notice when streaming crosses the cap", () => {
    const output = new NativeToolOutputAccumulator("Codex");
    const userOutputWithNotice =
      "before user marker\n...(OpenClaw truncated Codex native tool output: original literal process text)\nsecond line must survive\n";
    output.append("cmd-user-notice-prefix", userOutputWithNotice);
    const item = output.append("cmd-user-notice-prefix", "x".repeat(12_000));
    expect(item.text).toHaveLength(10_000);
    expect(item.text).toContain("OpenClaw truncated Codex native tool output");
    expect(item.text).toContain("original 12124 chars");
    expect(item.text).toContain("before user marker");
    expect(item.text).toContain("second line must survive");
  });
});

describe("native tool output formatting", () => {
  it("uses a safe markdown fence for verbose tool output", () => {
    expect(formatNativeToolOutput("read", undefined, "line\n```\nMEDIA:/tmp/secret.png")).toBe(
      "📖 Read\n````txt\nline\n```\nMEDIA:/tmp/secret.png\n````",
    );
  });
});
