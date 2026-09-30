// ACPX tests cover mcp command line plugin behavior.
import { describe, expect, it } from "vitest";

type SplitCommandLine = (
  value: string,
  platform?: string,
) => {
  command: string;
  args: string[];
};

async function loadSplitCommandLine(): Promise<SplitCommandLine> {
  const moduleUrl = new URL("./mcp-command-line.mjs", import.meta.url);
  return (await import(moduleUrl.href)).splitCommandLine as SplitCommandLine;
}

describe("mcp-command-line", () => {
  it("parses unquoted Windows executable paths without mangling backslashes", async () => {
    const splitCommandLine = await loadSplitCommandLine();
    const parsed = splitCommandLine("C:\\Users\\alerl\\.local\\bin\\claude.exe --version", "win32");

    expect(parsed).toEqual({
      command: "C:\\Users\\alerl\\.local\\bin\\claude.exe",
      args: ["--version"],
    });
  });

  it("preserves quoted and unquoted Windows arguments after a quoted executable", async () => {
    const splitCommandLine = await loadSplitCommandLine();
    const parsed = splitCommandLine(
      '"C:\\Program Files\\Claude\\claude.exe" --config C:\\Users\\me\\cfg.json --flag "two words"',
      "win32",
    );

    expect(parsed).toEqual({
      command: "C:\\Program Files\\Claude\\claude.exe",
      args: ["--config", "C:\\Users\\me\\cfg.json", "--flag", "two words"],
    });
  });

  it("rejects direct Windows wrapper-script commands with a helpful error", async () => {
    const splitCommandLine = await loadSplitCommandLine();
    expect(() =>
      splitCommandLine('"C:\\Users\\me\\bin\\claude-wrapper.cmd" --stdio', "win32"),
    ).toThrow(/Invoke wrapper scripts through their shell or interpreter instead/);
  });
});
