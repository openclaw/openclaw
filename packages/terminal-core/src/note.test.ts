/**
 * Tests for copy-sensitive token preservation in the note rendering pipeline
 * (fix #94730: Clack's second-wrap hard-wrapping no longer splits paths).
 *
 * Before the fix, `note()` delegated to `clackNote(...)` which re-wrapped the
 * message with hard wrapAnsi, splitting copy-sensitive tokens (paths, URLs,
 * file-like tokens) mid-token at the box boundary. After the fix, `note()`
 * renders the box itself, preserving the copy-safe wrapping already performed
 * by `wrapNoteMessage`.
 */
import { describe, expect, it } from "vitest";
import { resolveNoteColumns, withSuppressedNotes, note, wrapNoteMessage } from "./note.js";

describe("wrapNoteMessage copy-sensitive token preservation (#94730)", () => {
  it("keeps a long session lock path on a single line at 80 columns", () => {
    const path = "~/.openclaw/agents/main/sessions/9c2acae5-841f-4aea-936b-fdb513b60202.jsonl.lock";
    const wrapped = wrapNoteMessage(path, { columns: 80 });
    const lines = wrapped.split("\n");

    // The path must appear on one intact line with full extension
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(".jsonl.lock");
    // Bug was splitting .jsonl.lock across lines — verify no mid-path newline
    expect(lines[0]).not.toMatch(/\S+\n\S+/);
  });

  it("keeps URLs intact", () => {
    const url =
      "https://github.com/openclaw/openclaw/blob/main/packages/terminal-core/src/note.ts#L210";
    const wrapped = wrapNoteMessage(url, { columns: 80 });
    const lines = wrapped.split("\n");

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("https://");
    expect(lines[0]).toContain("note.ts");
  });

  it("keeps copy-sensitive tokens with underscores intact", () => {
    const path = "/etc/ssh/administrators_authorized_keys";
    const wrapped = wrapNoteMessage(path, { columns: 80 });
    const lines = wrapped.split("\n");

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("administrators_authorized_keys");
  });

  it("keeps Windows drive paths intact", () => {
    const path = "C:\\Users\\Name\\AppData\\Local\\openclaw\\data";
    const wrapped = wrapNoteMessage(path, { columns: 80 });
    const lines = wrapped.split("\n");

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("C:\\Users");
  });

  it("keeps absolute Unix paths intact", () => {
    const path =
      "/home/user/workspace/openclaw-worktrees/fix/issue-94730/packages/terminal-core/src/note.ts";
    const wrapped = wrapNoteMessage(path, { columns: 80 });
    const lines = wrapped.split("\n");

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("note.ts");
  });

  it("does not split a session lock line with path + metadata at 80 columns", () => {
    const input =
      "- Found 1 session lock file.\n" +
      "- ~/.openclaw/agents/main/sessions/9c2acae5-841f-4aea-936b-fdb513b60202.jsonl.lock pid=86519 (alive) age=2m47s stale=no";
    const wrapped = wrapNoteMessage(input, { columns: 80 });
    const lines = wrapped.split("\n");

    // The path line must contain the full .jsonl.lock extension
    const pathLine = lines.find((l) => l.includes("9c2acae5"));
    expect(pathLine).toBeTruthy();
    expect(pathLine!).toContain(".jsonl.lock");
    expect(pathLine!).not.toContain(".js\n");
  });
});

describe("resolveNoteColumns", () => {
  it("returns the given columns when >= MIN_NOTE_COLUMNS", () => {
    expect(resolveNoteColumns(120)).toBe(120);
    expect(resolveNoteColumns(80)).toBe(80);
  });

  it("falls back to MIN_NOTE_COLUMNS when too small", () => {
    expect(resolveNoteColumns(0)).toBe(80);
    expect(resolveNoteColumns(40)).toBe(80);
  });

  it("falls back to MIN_NOTE_COLUMNS for invalid input", () => {
    expect(resolveNoteColumns(undefined as unknown as number)).toBe(80);
  });
});

describe("withSuppressedNotes", () => {
  it("returns the callback result", () => {
    const result = withSuppressedNotes(() => 42);
    expect(result).toBe(42);
  });
});
