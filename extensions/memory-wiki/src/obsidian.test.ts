import path from "node:path";
import * as pathExistence from "openclaw/plugin-sdk/path-existence-runtime";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import { OBSIDIAN_ACTIONS, runObsidianAction } from "./obsidian.js";

const command = path.join(
  "/usr/local/bin",
  process.platform === "win32" ? "obsidian.EXE" : "obsidian",
);
beforeEach(() => {
  vi.stubEnv("PATH", "/usr/local/bin");
  vi.stubEnv("PATHEXT", ".EXE");
  vi.spyOn(pathExistence, "executableFileExists").mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("runObsidianAction", () => {
  it.each([
    { action: OBSIDIAN_ACTIONS[0], value: "agent memory", argv: ["search", "query=agent memory"] },
    { action: OBSIDIAN_ACTIONS[1], value: "notes/alpha.md", argv: ["open", "path=notes/alpha.md"] },
    {
      action: OBSIDIAN_ACTIONS[2],
      value: "workspace:save-file",
      argv: ["command", "id=workspace:save-file"],
    },
    { action: OBSIDIAN_ACTIONS[3], value: undefined, argv: ["daily"] },
  ])(
    "builds the official $action.command argv and bounds the request",
    async ({ action, value, argv: expectedArgv }) => {
      const config = resolveMemoryWikiConfig(
        {
          obsidian: {
            enabled: true,
            useOfficialCli: true,
            vaultName: "OpenClaw Wiki",
          },
        },
        { homedir: "/Users/tester" },
      );
      const exec = vi.spyOn(processRuntime, "runExec").mockResolvedValue({
        stdout: "search output\n",
        stderr: "",
      });
      const result = await runObsidianAction({
        config,
        action,
        value,
      });

      expect(exec).toHaveBeenCalledExactlyOnceWith(
        command,
        ["vault=OpenClaw Wiki", ...expectedArgv],
        {
          logOutput: false,
          timeoutMs: 10_000,
        },
      );
      expect(result.stdout).toBe("search output\n");
    },
  );
});

describe("Obsidian CLI availability", () => {
  it("fails cleanly when the obsidian cli is not installed", async () => {
    const config = resolveMemoryWikiConfig(undefined, { homedir: "/Users/tester" });
    vi.mocked(pathExistence.executableFileExists).mockResolvedValue(false);

    await expect(
      runObsidianAction({
        config,
        action: OBSIDIAN_ACTIONS[3],
      }),
    ).rejects.toThrow("Obsidian CLI is not available on PATH.");
  });
});
