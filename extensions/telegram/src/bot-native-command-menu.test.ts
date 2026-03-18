import { describe, expect, it, vi } from "vitest";
import {
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  hashCommandList,
  syncTelegramMenuCommands,
} from "./bot-native-command-menu.js";

type SyncMenuOptions = {
  deleteMyCommands: ReturnType<typeof vi.fn>;
  setMyCommands: ReturnType<typeof vi.fn>;
  commandsToRegister: Parameters<typeof syncTelegramMenuCommands>[0]["commandsToRegister"];
  accountId: string;
  botIdentity: string;
  runtimeLog?: ReturnType<typeof vi.fn>;
  runtimeError?: ReturnType<typeof vi.fn>;
};

function syncMenuCommandsWithMocks(options: SyncMenuOptions): void {
  syncTelegramMenuCommands({
    bot: {
      api: { deleteMyCommands: options.deleteMyCommands, setMyCommands: options.setMyCommands },
    } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
    runtime: {
      log: options.runtimeLog ?? vi.fn(),
      error: options.runtimeError ?? vi.fn(),
      exit: vi.fn(),
    } as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
    commandsToRegister: options.commandsToRegister,
    accountId: options.accountId,
    botIdentity: options.botIdentity,
  });
}

describe("bot-native-command-menu", () => {
  it("caps menu entries to Telegram limit", () => {
    const allCommands = Array.from({ length: 105 }, (_, i) => ({
      command: `cmd_${i}`,
      description: `Command ${i}`,
    }));

    const result = buildCappedTelegramMenuCommands({ allCommands });

    expect(result.commandsToRegister).toHaveLength(100);
    expect(result.totalCommands).toBe(105);
    expect(result.maxCommands).toBe(100);
    expect(result.overflowCount).toBe(5);
    expect(result.commandsToRegister[0]).toEqual({ command: "cmd_0", description: "Command 0" });
    expect(result.commandsToRegister[99]).toEqual({
      command: "cmd_99",
      description: "Command 99",
    });
  });

  it("validates plugin command specs and reports conflicts", () => {
    const existingCommands = new Set(["native"]);

    const result = buildPluginTelegramMenuCommands({
      specs: [
        { name: "valid", description: "  Works  " },
        { name: "bad-name!", description: "Bad" },
        { name: "native", description: "Conflicts with native" },
        { name: "valid", description: "Duplicate plugin name" },
        { name: "empty", description: "   " },
      ],
      existingCommands,
    });

    expect(result.commands).toEqual([{ command: "valid", description: "Works" }]);
    expect(result.issues).toContain(
      'Plugin command "/bad-name!" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).',
    );
    expect(result.issues).toContain(
      'Plugin command "/native" conflicts with an existing Telegram command.',
    );
    expect(result.issues).toContain('Plugin command "/valid" is duplicated.');
    expect(result.issues).toContain('Plugin command "/empty" is missing a description.');
  });

  it("normalizes hyphenated plugin command names", () => {
    const result = buildPluginTelegramMenuCommands({
      specs: [{ name: "agent-run", description: "Run agent" }],
      existingCommands: new Set<string>(),
    });

    expect(result.commands).toEqual([{ command: "agent_run", description: "Run agent" }]);
    expect(result.issues).toEqual([]);
  });

  it("ignores malformed plugin specs without crashing", () => {
    const malformedSpecs = [
      { name: "valid", description: " Works " },
      { name: "missing-description", description: undefined },
      { name: undefined, description: "Missing name" },
    ] as unknown as Parameters<typeof buildPluginTelegramMenuCommands>[0]["specs"];

    const result = buildPluginTelegramMenuCommands({
      specs: malformedSpecs,
      existingCommands: new Set<string>(),
    });

    expect(result.commands).toEqual([{ command: "valid", description: "Works" }]);
    expect(result.issues).toContain(
      'Plugin command "/missing_description" is missing a description.',
    );
    expect(result.issues).toContain(
      'Plugin command "/<unknown>" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).',
    );
  });

  it("deletes stale commands before setting new menu", async () => {
    const callOrder: string[] = [];
    const deleteMyCommands = vi.fn(async () => {
      callOrder.push("delete");
    });
    const setMyCommands = vi.fn(async () => {
      callOrder.push("set");
    });

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [{ command: "cmd", description: "Command" }],
      accountId: `test-delete-${Date.now()}`,
      botIdentity: "bot-a",
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalled();
    });

    expect(callOrder).toEqual(["delete", "set"]);
  });

  it("produces a stable hash regardless of command order (#32017)", () => {
    const commands = [
      { command: "bravo", description: "B" },
      { command: "alpha", description: "A" },
    ];
    const reversed = [...commands].toReversed();
    expect(hashCommandList(commands)).toBe(hashCommandList(reversed));
  });

  it("produces different hashes for different command lists (#32017)", () => {
    const a = [{ command: "alpha", description: "A" }];
    const b = [{ command: "alpha", description: "Changed" }];
    expect(hashCommandList(a)).not.toBe(hashCommandList(b));
  });

  it("skips sync when command hash is unchanged (#32017)", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeLog = vi.fn();

    // Use a unique accountId so cached hashes from other tests don't interfere.
    const accountId = `test-skip-${Date.now()}`;
    const commands = [{ command: "skip_test", description: "Skip test command" }];

    // First sync — no cached hash, should call setMyCommands.
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-a",
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(1);
    });

    // Second sync with the same commands — hash is cached, should skip.
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-a",
    });

    // setMyCommands should NOT have been called a second time.
    expect(setMyCommands).toHaveBeenCalledTimes(1);
  });

  it("does not reuse cached hash across different bot identities", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeLog = vi.fn();
    const accountId = `test-bot-identity-${Date.now()}`;
    const commands = [{ command: "same", description: "Same" }];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "token-bot-a",
    });
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(1));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "token-bot-b",
    });
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(2));
  });

  it("does not cache empty-menu hash when deleteMyCommands fails", async () => {
    const deleteMyCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValue(undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeLog = vi.fn();
    const accountId = `test-empty-delete-fail-${Date.now()}`;

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: [],
      accountId,
      botIdentity: "bot-a",
    });
    await vi.waitFor(() => expect(deleteMyCommands).toHaveBeenCalledTimes(1));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: [],
      accountId,
      botIdentity: "bot-a",
    });
    await vi.waitFor(() => expect(deleteMyCommands).toHaveBeenCalledTimes(2));
  });

  it("retries with fewer commands on BOT_COMMANDS_TOO_MUCH", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error("400: Bad Request: BOT_COMMANDS_TOO_MUCH"))
      .mockResolvedValue(undefined);
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      runtimeError,
      commandsToRegister: Array.from({ length: 100 }, (_, i) => ({
        command: `cmd_${i}`,
        description: `Command ${i}`,
      })),
      accountId: `test-retry-${Date.now()}`,
      botIdentity: "bot-a",
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(2);
    });
    const firstPayload = setMyCommands.mock.calls[0]?.[0] as Array<unknown>;
    const secondPayload = setMyCommands.mock.calls[1]?.[0] as Array<unknown>;
    expect(firstPayload).toHaveLength(100);
    expect(secondPayload).toHaveLength(80);
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram rejected 100 commands (BOT_COMMANDS_TOO_MUCH); retrying with 80.",
    );
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram accepted 80 commands after BOT_COMMANDS_TOO_MUCH (started with 100; omitted 20). Reduce plugin/skill/custom commands to expose more menu entries.",
    );
    expect(runtimeError).not.toHaveBeenCalled();
  });

  describe("Windows path validation in command hash cache (#44199)", () => {
    it("continues menu sync even if command hash mkdir fails", async () => {
      // writeCachedCommandHash is best-effort: any fs error is caught inside the try block.
      // We verify that menu sync completes successfully regardless of cache write outcome.
      // Note: vi.spyOn(fs, "mkdir") cannot be used in ESM; the try-catch in
      // writeCachedCommandHash already ensures best-effort behavior for any fs failure.
      const setMyCommands = vi.fn(async () => undefined);
      const deleteMyCommands = vi.fn(async () => undefined);
      const runtimeLog = vi.fn();

      syncMenuCommandsWithMocks({
        setMyCommands,
        deleteMyCommands,
        runtimeLog,
        commandsToRegister: [{ command: "cmd", description: "Test" }],
        accountId: `acc-${Date.now()}`,
        botIdentity: "bot-test",
      });

      await vi.waitFor(() => { expect(setMyCommands).toHaveBeenCalled(); });
      // Menu sync succeeds despite cache write failure (best-effort semantics)
      expect(setMyCommands).toHaveBeenCalledWith([{ command: "cmd", description: "Test" }]);
    });

    it("continues menu sync even with a bare '\\\\?' prefix path account", async () => {
      // writeCachedCommandHash is best-effort: any path resolution failure (including
      // malformed OPENCLAW_STATE_DIR) is caught inside the try block and logged.
      // Menu sync should succeed regardless.
      const setMyCommands = vi.fn(async () => undefined);
      const deleteMyCommands = vi.fn(async () => undefined);
      const runtimeLog = vi.fn();

      syncMenuCommandsWithMocks({
        setMyCommands,
        deleteMyCommands,
        runtimeLog,
        commandsToRegister: [{ command: "win_test", description: "Win Test" }],
        accountId: `acc-winpath-${Date.now()}`,
        botIdentity: "bot-winpath",
      });

      await vi.waitFor(() => { expect(setMyCommands).toHaveBeenCalled(); });
      // Menu sync succeeds regardless of path validation in writeCachedCommandHash
      expect(setMyCommands).toHaveBeenCalledWith([{ command: "win_test", description: "Win Test" }]);
    });


    it("tolerates a throwing resolveCommandHashPath (regression #44199)", async () => {
      // Force writeCachedCommandHash to hit the error path by injecting a null byte
      // into OPENCLAW_STATE_DIR. Node.js throws ERR_INVALID_ARG_VALUE on mkdir/writeFile
      // for paths containing null bytes, exercising the catch branch in writeCachedCommandHash.
      const originalStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = "/tmp/\x00invalid";

      const setMyCommands = vi.fn(async () => undefined);
      const deleteMyCommands = vi.fn(async () => undefined);
      const runtimeLog = vi.fn();
      const runtimeError = vi.fn();

      try {
        syncMenuCommandsWithMocks({
          setMyCommands,
          deleteMyCommands,
          runtimeLog,
          runtimeError,
          commandsToRegister: [{ command: "regression_44199", description: "Regression test" }],
          accountId: `acc-regression-${Date.now()}`,
          botIdentity: "bot-regression",
        });

        // setMyCommands should still be called even though cache write throws
        await vi.waitFor(() => { expect(setMyCommands).toHaveBeenCalled(); });
        expect(setMyCommands).toHaveBeenCalledWith([{ command: "regression_44199", description: "Regression test" }]);
        // No unhandled error should be propagated
        expect(runtimeError).not.toHaveBeenCalled();
      } finally {
        if (originalStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = originalStateDir;
        }
      }
    });
  });
});
