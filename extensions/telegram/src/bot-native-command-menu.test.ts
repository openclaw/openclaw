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

  describe("Windows path validation (#44199)", () => {
    it("rejects bare Windows extended-length path prefix", async () => {
      const pathsModule = await import("../config/paths.js");
      const fs = await import("node:fs/promises");
      
      // Mock resolveStateDir to return invalid path (bare prefix)
      const resolveStateDirSpy = vi.spyOn(pathsModule, "resolveStateDir");
      resolveStateDirSpy.mockReturnValue("\\?");
      
      const fsMkdirSpy = vi.spyOn(fs, "mkdir");
      const fsWriteFileSpy = vi.spyOn(fs, "writeFile");
      
      // Mkdir and writeFile should not be called
      fsMkdirSpy.mockResolvedValue(undefined);
      fsWriteFileSpy.mockResolvedValue(undefined);

      const deleteMyCommands = vi.fn(async () => undefined);
      const setMyCommands = vi.fn(async () => undefined);
      const runtimeLog = vi.fn();
      
      const accountId = `test-bare-prefix-${Date.now()}`;
      const commands = [{ command: "test_cmd", description: "Test command" }];

      syncMenuCommandsWithMocks({
        deleteMyCommands,
        setMyCommands,
        runtimeLog,
        commandsToRegister: commands,
        accountId,
        botIdentity: "bot-bare-prefix-test",
      });

      await vi.waitFor(() => {
        expect(setMyCommands).toHaveBeenCalled();
      });

      // The guard should have thrown before mkdir, so mkdir is NOT called
      expect(fsMkdirSpy).not.toHaveBeenCalled();
      expect(fsWriteFileSpy).not.toHaveBeenCalled();
      
      // Menu sync succeeds (best-effort cache write failure is silently handled)
      expect(setMyCommands).toHaveBeenCalledWith([
        { command: "test_cmd", description: "Test command" },
      ]);

      resolveStateDirSpy.mockRestore();
      fsMkdirSpy.mockRestore();
      fsWriteFileSpy.mockRestore();
    });

    it("allows valid Windows extended-length paths", async () => {
      const pathsModule = await import("../config/paths.js");
      const fs = await import("node:fs/promises");
      
      // Mock resolveStateDir to return valid extended-length path
      const resolveStateDirSpy = vi.spyOn(pathsModule, "resolveStateDir");
      resolveStateDirSpy.mockReturnValue("\\?\\C:\\Users\\test\\.openclaw");
      
      const fsMkdirSpy = vi.spyOn(fs, "mkdir");
      const fsWriteFileSpy = vi.spyOn(fs, "writeFile");
      
      fsMkdirSpy.mockResolvedValue(undefined);
      fsWriteFileSpy.mockResolvedValue(undefined);

      const deleteMyCommands = vi.fn(async () => undefined);
      const setMyCommands = vi.fn(async () => undefined);
      const runtimeLog = vi.fn();
      
      const accountId = `test-valid-extended-${Date.now()}`;
      const commands = [{ command: "valid_test", description: "Valid test" }];

      syncMenuCommandsWithMocks({
        deleteMyCommands,
        setMyCommands,
        runtimeLog,
        commandsToRegister: commands,
        accountId,
        botIdentity: "bot-valid-extended-test",
      });

      await vi.waitFor(() => {
        expect(setMyCommands).toHaveBeenCalled();
      });

      // Valid extended-length paths should pass through and mkdir should be called
      expect(fsMkdirSpy).toHaveBeenCalled();
      expect(fsWriteFileSpy).toHaveBeenCalled();

      resolveStateDirSpy.mockRestore();
      fsMkdirSpy.mockRestore();
      fsWriteFileSpy.mockRestore();
    });

    it("continues menu sync even if command hash cache write fails", async () => {
      const fs = await import("node:fs/promises");
      const fsMkdirSpy = vi.spyOn(fs, "mkdir");
      
      // Simulate mkdir failure (e.g., due to permissions or disk full)
      fsMkdirSpy.mockRejectedValue(new Error("EACCES: permission denied"));

      const deleteMyCommands = vi.fn(async () => undefined);
      const setMyCommands = vi.fn(async () => undefined);
      const runtimeLog = vi.fn();
      
      const accountId = `test-mkdir-fail-${Date.now()}`;
      const commands = [{ command: "fail_test", description: "Fail test command" }];

      syncMenuCommandsWithMocks({
        deleteMyCommands,
        setMyCommands,
        runtimeLog,
        commandsToRegister: commands,
        accountId,
        botIdentity: "bot-fail-test",
      });

      await vi.waitFor(() => {
        expect(setMyCommands).toHaveBeenCalled();
      });

      // The menu sync should succeed despite mkdir failure (best-effort)
      expect(setMyCommands).toHaveBeenCalledWith([
        { command: "fail_test", description: "Fail test command" },
      ]);

      fsMkdirSpy.mockRestore();
    });
  });
});
