import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMemoryCli } from "./cli.js";

const fixture = vi.hoisted(() => ({
  admit: vi.fn<typeof import("openclaw/plugin-sdk/cli-state-owner").runWithLocalStateOwner>(),
  runtimeLoaded: vi.fn(),
}));

// mock-isolation: Keep physical ownership in core's integration test; stop before domain work.
vi.mock("openclaw/plugin-sdk/cli-state-owner", () => ({
  runWithLocalStateOwner: fixture.admit,
}));

// mock-isolation: A refused CLI must not load any memory domain runtime.
vi.mock("./cli.runtime.js", () => {
  fixture.runtimeLoaded();
  return {};
});

afterEach(() => vi.clearAllMocks());

describe("memory CLI owner admission", () => {
  it.each([
    [["status"], "memory.cli", true],
    [["index"], "memory.cli", true],
    [["search", "query"], "memory.search.owner", false],
    [["forget", "--session", "fixture"], "memory.cli", true],
    [["reset", "--yes"], "memory.cli", true],
    [["promote", "--apply"], "memory.cli", true],
    [["promote-explain", "fixture"], "memory.cli", true],
    [["rem-harness"], "memory.cli", true],
    [["rem-backfill", "--stage-short-term"], "memory.cli", true],
    [["session-backfill"], "memory.sessionBackfill.preview.owner", false],
    [["session-backfill", "--apply"], "memory.sessionBackfill.apply.owner", false],
    [["session-backfill", "--rollback"], "memory.sessionBackfill.rollback.owner", false],
    [
      ["session-backfill", "--apply", "--archive-files", "archive.jsonl"],
      "memory.sessionBackfill.apply.owner",
      true,
    ],
    [["session-backfill", "--rem"], "memory.sessionBackfill.preview.owner", true],
  ] as const)("admits %j through %s before domain execution", async (args, method, offline) => {
    const refused = new Error("fixture owner refused");
    fixture.admit.mockRejectedValueOnce(refused);
    const program = new Command();
    registerMemoryCli(program);

    await expect(program.parseAsync(["memory", ...args], { from: "user" })).rejects.toBe(refused);

    expect(fixture.admit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ method, runLocal: expect.any(Function) }),
    );
    expect(fixture.admit.mock.calls[0]?.[0].onForeignOwner).toBe(offline ? "refuse" : undefined);
    expect(fixture.runtimeLoaded).not.toHaveBeenCalled();
  });
});
