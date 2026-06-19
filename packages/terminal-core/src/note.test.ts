// Terminal Core tests cover note behavior.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { stripAnsi } from "./ansi.js";
import { note, withSuppressedNotes, wrapNoteMessage } from "./note.js";

function spyStdoutWrite() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return true;
  });
  return { spy, chunks };
}

function setColumns(n: number) {
  Object.defineProperty(process.stdout, "columns", {
    value: n,
    configurable: true,
  });
}

describe("wrapNoteMessage", () => {
  it("preserves a copy-sensitive path that exceeds the wrap width", () => {
    const longPath =
      "~/.openclaw/agents/main/sessions/9c2acae5-841f-4aea-936b-fdb513b60202.jsonl.lock";
    const msg = `- Found lock at ${longPath} pid=86519 (alive)`;
    const result = wrapNoteMessage(msg, { columns: 80, maxWidth: 68 });
    const lines = result.split("\n");
    const pathLine = lines.find((l) => l.includes(".jsonl.lock"));
    expect(pathLine).toBeDefined();
    expect(pathLine!).toContain(longPath);
  });

  it("preserves a URL that exceeds the wrap width", () => {
    const url =
      "https://example.com/very/long/path/that/exceeds/normal/line/width/endpoint/v1/users";
    const msg = `- See ${url} for details`;
    const result = wrapNoteMessage(msg, { columns: 80, maxWidth: 70 });
    const lines = result.split("\n");
    const urlLine = lines.find((l) => l.includes("https://"));
    expect(urlLine).toBeDefined();
    expect(urlLine!).toContain(url);
  });

  it("wraps long non-copy-sensitive words at the wrap width", () => {
    const longWord = "supercalifragilisticexpialidocious";
    const result = wrapNoteMessage(`- ${longWord}`, {
      columns: 80,
      maxWidth: 20,
    });
    const lines = result.split("\n");
    expect(lines.length).toBeGreaterThan(1);
  });
});

describe("note box rendering", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let chunks: string[];

  beforeEach(() => {
    setColumns(80);
    const spied = spyStdoutWrite();
    writeSpy = spied.spy;
    chunks = spied.chunks;
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  function getOutput(): string {
    return stripAnsi(chunks.join(""));
  }

  it("renders a note box with title and message", () => {
    note("hello world", "Title");
    const out = getOutput();
    expect(out).toContain("◇");
    expect(out).toContain("Title");
    expect(out).toContain("hello world");
    expect(out).toContain("╮");
    expect(out).toContain("╰");
    expect(out).toContain("╯");
  });

  it("renders content lines with proper box borders", () => {
    note("- item one\n- item two", "List");
    const out = getOutput();
    expect(out).toContain("│");
    expect(out).toContain("- item one");
    expect(out).toContain("- item two");
  });

  it("does not re-wrap a copy-sensitive path inside the box", () => {
    const lockPath =
      "~/.openclaw/agents/main/sessions/9c2acae5-841f-4aea-936b-fdb513b60202.jsonl.lock";
    const msg = `- Found 1 session lock file.\n- ${lockPath} pid=86519 (alive) age=2m47s stale=no`;
    note(msg, "Session locks");
    const out = getOutput();
    // The path must appear intact — not split across lines inside the box.
    expect(out).toContain(lockPath);
    // The extension ".jsonl.lock" must appear as one unbroken unit.
    expect(out).toContain(".jsonl.lock");
  });

  it("allows a copy-sensitive line to overflow the box right border", () => {
    const longPath = "/" + "a/".repeat(30) + "very-long-filename.jsonl.lock";
    const msg = `- ${longPath}`;
    note(msg, "Path overflow");
    const out = getOutput();
    // The path must appear intact.
    expect(out).toContain(longPath);
    // The bottom border should still be rendered.
    expect(out).toContain("╰");
  });
});

describe("note suppression", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setColumns(80);
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("suppresses output when OPENCLAW_SUPPRESS_NOTES is set", () => {
    vi.stubEnv("OPENCLAW_SUPPRESS_NOTES", "1");
    note("should not appear");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("suppresses output inside withSuppressedNotes callback", () => {
    withSuppressedNotes(() => {
      note("should not appear");
    });
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
