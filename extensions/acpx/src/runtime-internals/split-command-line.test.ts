import { describe, expect, it } from "vitest";
import { splitCommandLine } from "./split-command-line.mjs";

describe("splitCommandLine", () => {
  it("preserves backslashes in unquoted Windows command paths", () => {
    expect(splitCommandLine(String.raw`C:\Users\bob\codex.cmd --flag`)).toEqual({
      command: String.raw`C:\Users\bob\codex.cmd`,
      args: ["--flag"],
    });
  });

  it("still treats backslashes before whitespace as escapes", () => {
    expect(splitCommandLine(String.raw`my\ command --flag`)).toEqual({
      command: "my command",
      args: ["--flag"],
    });
  });
});
