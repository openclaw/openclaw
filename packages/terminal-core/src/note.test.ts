// Terminal Core tests cover note copy-sensitive token preservation.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { visibleWidth } from "./ansi.js";

// Mock @clack/prompts before importing note.js
const clackNoteMock = vi.fn();
vi.mock("@clack/prompts", () => ({ note: clackNoteMock }));
vi.mock("./prompt-style.js", () => ({ stylePromptTitle: (t: string | undefined) => t ?? "" }));

describe("note copy-sensitive token preservation", () => {
  let originalColumns: number | undefined;

  beforeEach(() => {
    originalColumns = process.stdout.columns;
    clackNoteMock.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", {
      value: originalColumns,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it("does not re-break copy-sensitive paths passed to clackNote", async () => {
    // Simulate 80-column terminal
    Object.defineProperty(process.stdout, "columns", {
      value: 80,
      configurable: true,
      writable: true,
    });

    const { note } = await import("./note.js");
    const longPath =
      "~/.openclaw/agents/main/sessions/9c2acae5-841f-4aea-936b-fdb513b60202.jsonl.lock";
    const message = `- Found 1 session lock file.\n- ${longPath} pid=86519 (alive) age=2m47s stale=no`;

    note(message, "Session locks");

    expect(clackNoteMock).toHaveBeenCalledOnce();
    const passedMessage = clackNoteMock.mock.calls[0][0] as string;
    const lines = passedMessage.split("\n");

    // Find the line containing the path
    const pathLine = lines.find((l: string) => l.includes("9c2acae5"));
    expect(pathLine).toBeDefined();
    // The path must NOT be broken — the full token must be on one line
    expect(pathLine).toContain(longPath);
    // The path should NOT be split across lines (no line ending in ".js" with next starting "onl.lock")
    expect(pathLine).not.toMatch(/\.js\s*$/);
  });

  it("pads lines to contentWidth to prevent clack re-wrapping", async () => {
    Object.defineProperty(process.stdout, "columns", {
      value: 80,
      configurable: true,
      writable: true,
    });

    const { note } = await import("./note.js");
    note("- short line", "Test");

    expect(clackNoteMock).toHaveBeenCalledOnce();
    const passedMessage = clackNoteMock.mock.calls[0][0] as string;
    const lines = passedMessage.split("\n");
    const contentWidth = 80 - 6; // columns - 6

    // Every line should be padded to exactly contentWidth (visible width)
    for (const line of lines) {
      // Skip empty lines (the first and last padding lines from note())
      if (line.trim() === "") continue;
      expect(visibleWidth(line)).toBe(contentWidth);
    }
  });
});
