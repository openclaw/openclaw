import { describe, expect, it } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import { runObsidianDaily, runObsidianSearch } from "./obsidian.js";

describe("runObsidianSearch", () => {
  it("builds the official obsidian cli argv with the configured vault name", async () => {
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
    const calls: Array<{ command: string; argv: string[] }> = [];
    const exec = (async (
      ...args: Parameters<
        NonNullable<NonNullable<Parameters<typeof runObsidianSearch>[0]["deps"]>["exec"]>
      >
    ) => {
      const [command, argvOrOptions] = args;
      const argv = Array.isArray(argvOrOptions) ? [...argvOrOptions] : [];
      calls.push({ command, argv });
      return { stdout: "search output\n", stderr: "" };
    }) as NonNullable<NonNullable<Parameters<typeof runObsidianSearch>[0]["deps"]>["exec"]>;

    const result = await runObsidianSearch({
      config,
      query: "agent memory",
      deps: {
        exec,
        resolveCommand: async () => "/usr/local/bin/obsidian",
      },
    });

    expect(calls).toEqual([
      {
        command: "/usr/local/bin/obsidian",
        argv: ["vault=OpenClaw Wiki", "search", "query=agent memory"],
      },
    ]);
    expect(result.stdout).toBe("search output\n");
  });
});

describe("runObsidianDaily", () => {
  it("fails cleanly when the obsidian cli is not installed", async () => {
    const config = resolveMemoryWikiConfig(undefined, { homedir: "/Users/tester" });

    await expect(
      runObsidianDaily({
        config,
        deps: {
          resolveCommand: async () => null,
        },
      }),
    ).rejects.toThrow("Obsidian CLI is not available on PATH.");
  });
});
