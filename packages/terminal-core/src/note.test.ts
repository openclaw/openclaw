import { describe, expect, it } from "vitest";
import { stripAnsi, visibleWidth } from "./ansi.js";
import { noteToStream, resolveNoteColumns, wrapNoteMessage } from "./note.js";

function renderNote(message: string) {
  const writes: string[] = [];
  const output = {
    columns: 80,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;

  noteToStream(message, "Note", output);
  return stripAnsi(writes.join(""));
}

describe("wrapNoteMessage", () => {
  it("preserves note whitespace across Unicode paragraph separator line endings", () => {
    const input = ["First paragraph.", "", "- Workspace: ~/two  spaces"].join("\u2029");
    const rendered = renderNote(input);
    expect(rendered).toContain("First paragraph.");
    expect(rendered).toContain("- Workspace: ~/two  spaces");
    expect(wrapNoteMessage(input, { columns: 80 })).toBe(input.replaceAll("\u2029", "\n"));
  });

  it.each([
    [
      "A longer introduction that wraps: /tmp/two  spaces/file",
      "A longer introduction that\nwraps: /tmp/two  spaces/file",
    ],
    ["  - use  two spaces and another token", "  - use  two spaces and\n    another token"],
    ["1234567890123456789012345\t\tx", "1234567890123456789012345 x"],
  ])("preserves literal spaces and normalizes other separators: %s", (input, expected) => {
    expect(wrapNoteMessage(input, { maxWidth: 30 })).toBe(expected);
  });

  it("preserves long file-like underscore tokens for copy safety", () => {
    const input =
      "administrators_authorized_keys_with_extra_suffix_and_more_to_exceed_the_note_width";
    const wrapped = wrapNoteMessage(input, { columns: 80 });
    expect(wrapped).toBe(input);
  });

  it("clamps bogus TTY columns before clack wraps note text", () => {
    expect([undefined, 0, 1, 79, 120].map(resolveNoteColumns)).toEqual([80, 80, 80, 80, 120]);
  });

  it("widens note output columns so clack does not re-wrap copy-sensitive lines", () => {
    const message = [
      "- Found 1 session lock file.",
      "- ~/.openclaw/agents/main/sessions/9c2acae5-841f-4aea-936b-fdb513b60202.jsonl.lock pid=86519 (alive) age=2m47s stale=no",
    ].join("\n");
    const rendered = renderNote(message);
    expect(rendered).toContain(".jsonl.lock");
    expect(rendered).not.toContain(".js\n");
    expect(rendered).toContain(
      "- ~/.openclaw/agents/main/sessions/9c2acae5-841f-4aea-936b-fdb513b60202.jsonl.lock",
    );
  });

  it("coerces nullish and non-string note messages before wrapping", () => {
    expect(wrapNoteMessage(undefined, { columns: 80 })).toBe("");
    expect(wrapNoteMessage(null, { columns: 80 })).toBe("");
    expect(wrapNoteMessage(12345, { columns: 80 })).toBe("12345");
    expect(wrapNoteMessage(new Error("boom"), { columns: 80 })).toBe("Error: boom");
    expect(wrapNoteMessage({ message: "boom" }, { columns: 80 })).toBe("");
  });

  it("keeps wrapped lines within the visible-column budget for wide (CJK) words", () => {
    // Fullwidth characters must wrap by visible columns, not code-point count.
    const input = "東京特許許可局長今日休暇許可局長今日休暇東京特許".repeat(2);
    const lines = wrapNoteMessage(input, { columns: 80 }).split("\n");
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(70);
    }
    expect(lines.join("")).toBe(input);
  });
});
