// Terminal Core tests cover note wrapping behavior.
import { describe, expect, it } from "vitest";
import { wrapNoteMessage, note } from "./note.js";

describe("note copy-sensitive token preservation", () => {
  it("preserves long file paths as a single line in wrapNoteMessage", () => {
    const longPath =
      "~/.openclaw/agents/main/sessions/9c2acae5-841f-4aea-936b-fdb513b60202.jsonl.lock";
    const message = "Session lock: " + longPath;
    const wrapped = wrapNoteMessage(message, { columns: 80 });
    const lines = wrapped.split("\n");

    // The path should appear intact on one line (not split across lines)
    const pathLine = lines.find((l) => l.includes(longPath));
    expect(pathLine).toBeDefined();
  });

  it("preserves URLs as a single line in wrapNoteMessage", () => {
    const longUrl = "https://api.example.com/v1/users/123456789/sessions/abcdef0123456789/config";
    const message = "Endpoint: " + longUrl;
    const wrapped = wrapNoteMessage(message, { columns: 80 });
    const lines = wrapped.split("\n");

    const urlLine = lines.find((l) => l.includes(longUrl));
    expect(urlLine).toBeDefined();
  });

  it("preserves Windows paths as a single line in wrapNoteMessage", () => {
    const winPath = "C:\\Users\\Administrator\\.openclaw\\agents\\main\\sessions\\lock.jsonl.lock";
    const message = "Lock file: " + winPath;
    const wrapped = wrapNoteMessage(message, { columns: 80 });
    const lines = wrapped.split("\n");

    const pathLine = lines.find((l) => l.includes(winPath));
    expect(pathLine).toBeDefined();
  });

  it("does not re-break copy-sensitive tokens via clack note rendering", () => {
    // This test verifies the fix: clack's note() uses a wide virtual stream
    // so its internal wrap does not re-break copy-sensitive tokens.
    const longPath =
      "~/.openclaw/agents/main/sessions/9c2acae5-841f-4aea-936b-fdb513b60202.jsonl.lock";
    const message = "Session lock: " + longPath;

    const output: string[] = [];
    const mockStream = {
      columns: 80,
      write: (chunk: string) => {
        output.push(chunk);
        return true;
      },
      isTTY: true,
    };

    note(message, "Test", {
      output: mockStream as NodeJS.WriteStream,
      format: (line: string) => line,
    });

    const result = output.join("");
    // The path should appear intact in the rendered output
    expect(result).toContain(longPath);
  });
});
