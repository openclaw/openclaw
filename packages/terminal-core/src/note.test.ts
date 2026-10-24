import { note as clackNote } from "@clack/prompts";
import { describe, expect, it } from "vitest";
import { stripAnsi, visibleWidth } from "./ansi.js";
import {
  noteToStream,
  resolveNoteColumns,
  resolveNoteOutputColumns,
  wrapNoteMessage,
} from "./note.js";

describe("wrapNoteMessage", () => {
  it.each([["Unicode paragraph separator", "\u2029"]])(
    "preserves note text across %s line endings",
    (_label, separator) => {
      const input = ["First paragraph.", "", "- Second paragraph."].join(separator);
      const writes: string[] = [];
      const output = {
        columns: 80,
        write(chunk: string) {
          writes.push(chunk);
          return true;
        },
      } as unknown as NodeJS.WriteStream;

      noteToStream(input, "Note", output);

      const rendered = stripAnsi(writes.join(""));
      expect(rendered).toContain("First paragraph.");
      expect(rendered).toContain("- Second paragraph.");
      expect(wrapNoteMessage(input, { columns: 80 })).toBe(
        "First paragraph.\n\n- Second paragraph.",
      );
    },
  );

  it("preserves long file-like underscore tokens for copy safety", () => {
    const input =
      "administrators_authorized_keys_with_extra_suffix_and_more_to_exceed_the_note_width";
    const wrapped = wrapNoteMessage(input, { columns: 80 });
    expect(wrapped).toBe(input);
  });

  it("clamps bogus TTY columns before clack wraps note text", () => {
    expect(resolveNoteColumns(undefined)).toBe(80);
    expect(resolveNoteColumns(0)).toBe(80);
    expect(resolveNoteColumns(1)).toBe(80);
    expect(resolveNoteColumns(79)).toBe(80);
    expect(resolveNoteColumns(120)).toBe(120);
  });

  it("widens note output columns so clack does not re-wrap copy-sensitive lines", () => {
    const wrapped = wrapNoteMessage(
      [
        "- Found 1 session lock file.",
        "- ~/.openclaw/agents/main/sessions/9c2acae5-841f-4aea-936b-fdb513b60202.jsonl.lock pid=86519 (alive) age=2m47s stale=no",
      ].join("\n"),
      { columns: 80 },
    );
    const writes: string[] = [];
    const output = {
      columns: resolveNoteOutputColumns(wrapped, 80),
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    clackNote(wrapped, "Session locks", { output });

    const rendered = writes.join("");
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
