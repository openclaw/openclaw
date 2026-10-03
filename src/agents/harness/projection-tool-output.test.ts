import { describe, expect, it } from "vitest";
import { formatNativeToolOutput, NativeToolOutputAccumulator } from "./projection-tool-output.js";

describe("native tool output accumulation", () => {
  it.each(["split surrogate", "literal notice", "notice across cap"])(
    "accumulates %s without corrupting process output",
    (mode) => {
      const output = new NativeToolOutputAccumulator("Codex");
      const literalNotice =
        "...(OpenClaw truncated Codex native tool output is a literal line from the process)\n";
      const first =
        mode === "split surrogate"
          ? `${"a".repeat(9_886)}😀${"a".repeat(400)}`
          : mode === "literal notice"
            ? literalNotice
            : "before user marker\n...(OpenClaw truncated Codex native tool output: original literal process text)\nsecond line must survive\n";
      const delta =
        mode === "split surrogate"
          ? "must not resurrect a split surrogate"
          : mode === "literal notice"
            ? "second line must survive\n"
            : "x".repeat(12_000);
      output.append("cmd", first);
      const item = output.append("cmd", delta);
      if (mode === "literal notice") {
        expect(item.text).toBe(`${literalNotice}second line must survive\n`);
      } else {
        expect(item.text).toContain("OpenClaw truncated Codex native tool output");
        if (mode === "split surrogate") {
          expect(item.text).not.toMatch(/[\uD800-\uDFFF]/);
          expect(item.text).toContain("showing 10000");
        } else {
          expect(item.text).toHaveLength(10_000);
          expect(item.text).toContain("original 12124 chars");
          expect(item.text).toContain("before user marker");
          expect(item.text).toContain("second line must survive");
        }
      }
    },
  );
});

describe("native tool output formatting", () => {
  it("uses a safe markdown fence for verbose tool output", () => {
    expect(formatNativeToolOutput("read", undefined, "line\n```\nMEDIA:/tmp/secret.png")).toBe(
      "📖 Read\n````txt\nline\n```\nMEDIA:/tmp/secret.png\n````",
    );
  });
});
