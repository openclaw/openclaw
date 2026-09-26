import { describe, expect, it } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import { OBSIDIAN_ACTIONS, runObsidianAction } from "./obsidian.js";

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
      const calls: Array<{ command: string; argv: string[]; options: unknown }> = [];
      const execImpl = async (
        command: string,
        argv?: readonly string[] | null,
        options?: unknown,
      ) => {
        calls.push({ command, argv: argv ? [...argv] : [], options });
        return { stdout: "search output\n", stderr: "" };
      };
      const result = await runObsidianAction({
        config,
        action,
        value,
        deps: {
          exec: execImpl,
          resolveCommand: async () => "/usr/local/bin/obsidian",
        },
      });

      expect(calls).toEqual([
        {
          command: "/usr/local/bin/obsidian",
          argv: ["vault=OpenClaw Wiki", ...expectedArgv],
          options: { logOutput: false, timeoutMs: 10_000 },
        },
      ]);
      expect(result.stdout).toBe("search output\n");
    },
  );
});

describe("Obsidian CLI availability", () => {
  it("fails cleanly when the obsidian cli is not installed", async () => {
    const config = resolveMemoryWikiConfig(undefined, { homedir: "/Users/tester" });

    await expect(
      runObsidianAction({
        config,
        action: OBSIDIAN_ACTIONS[3],
        deps: {
          resolveCommand: async () => null,
        },
      }),
    ).rejects.toThrow("Obsidian CLI is not available on PATH.");
  });
});
