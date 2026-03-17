import { describe, expect, it, vi } from "vitest";
import {
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  hashCommandList,
  syncTelegramMenuCommands
} from "./bot-native-command-menu.js";
function syncMenuCommandsWithMocks(options) {
  syncTelegramMenuCommands({
    bot: {
      api: { deleteMyCommands: options.deleteMyCommands, setMyCommands: options.setMyCommands }
    },
    runtime: {
      log: options.runtimeLog ?? vi.fn(),
      error: options.runtimeError ?? vi.fn(),
      exit: vi.fn()
    },
    commandsToRegister: options.commandsToRegister,
    accountId: options.accountId,
    botIdentity: options.botIdentity
  });
}
describe("bot-native-command-menu", () => {
  it("caps menu entries to Telegram limit", () => {
    const allCommands = Array.from({ length: 105 }, (_, i) => ({
      command: `cmd_${i}`,
      description: `Command ${i}`
    }));
    const result = buildCappedTelegramMenuCommands({ allCommands });
    expect(result.commandsToRegister).toHaveLength(100);
    expect(result.totalCommands).toBe(105);
    expect(result.maxCommands).toBe(100);
    expect(result.overflowCount).toBe(5);
    expect(result.commandsToRegister[0]).toEqual({ command: "cmd_0", description: "Command 0" });
    expect(result.commandsToRegister[99]).toEqual({
      command: "cmd_99",
      description: "Command 99"
    });
  });
  it("validates plugin command specs and reports conflicts", () => {
    const existingCommands = /* @__PURE__ */ new Set(["native"]);
    const result = buildPluginTelegramMenuCommands({
      specs: [
        { name: "valid", description: "  Works  " },
        { name: "bad-name!", description: "Bad" },
        { name: "native", description: "Conflicts with native" },
        { name: "valid", description: "Duplicate plugin name" },
        { name: "empty", description: "   " }
      ],
      existingCommands
    });
    expect(result.commands).toEqual([{ command: "valid", description: "Works" }]);
    expect(result.issues).toContain(
      'Plugin command "/bad-name!" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).'
    );
    expect(result.issues).toContain(
      'Plugin command "/native" conflicts with an existing Telegram command.'
    );
    expect(result.issues).toContain('Plugin command "/valid" is duplicated.');
    expect(result.issues).toContain('Plugin command "/empty" is missing a description.');
  });
  it("normalizes hyphenated plugin command names", () => {
    const result = buildPluginTelegramMenuCommands({
      specs: [{ name: "agent-run", description: "Run agent" }],
      existingCommands: /* @__PURE__ */ new Set()
    });
    expect(result.commands).toEqual([{ command: "agent_run", description: "Run agent" }]);
    expect(result.issues).toEqual([]);
  });
  it("ignores malformed plugin specs without crashing", () => {
    const malformedSpecs = [
      { name: "valid", description: " Works " },
      { name: "missing-description", description: void 0 },
      { name: void 0, description: "Missing name" }
    ];
    const result = buildPluginTelegramMenuCommands({
      specs: malformedSpecs,
      existingCommands: /* @__PURE__ */ new Set()
    });
    expect(result.commands).toEqual([{ command: "valid", description: "Works" }]);
    expect(result.issues).toContain(
      'Plugin command "/missing_description" is missing a description.'
    );
    expect(result.issues).toContain(
      'Plugin command "/<unknown>" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).'
    );
  });
  it("deletes stale commands before setting new menu", async () => {
    const callOrder = [];
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
      botIdentity: "bot-a"
    });
    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalled();
    });
    expect(callOrder).toEqual(["delete", "set"]);
  });
  it("produces a stable hash regardless of command order (#32017)", () => {
    const commands = [
      { command: "bravo", description: "B" },
      { command: "alpha", description: "A" }
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
    const deleteMyCommands = vi.fn(async () => void 0);
    const setMyCommands = vi.fn(async () => void 0);
    const runtimeLog = vi.fn();
    const accountId = `test-skip-${Date.now()}`;
    const commands = [{ command: "skip_test", description: "Skip test command" }];
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-a"
    });
    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(1);
    });
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-a"
    });
    expect(setMyCommands).toHaveBeenCalledTimes(1);
  });
  it("does not reuse cached hash across different bot identities", async () => {
    const deleteMyCommands = vi.fn(async () => void 0);
    const setMyCommands = vi.fn(async () => void 0);
    const runtimeLog = vi.fn();
    const accountId = `test-bot-identity-${Date.now()}`;
    const commands = [{ command: "same", description: "Same" }];
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "token-bot-a"
    });
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(1));
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "token-bot-b"
    });
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(2));
  });
  it("does not cache empty-menu hash when deleteMyCommands fails", async () => {
    const deleteMyCommands = vi.fn().mockRejectedValueOnce(new Error("transient failure")).mockResolvedValue(void 0);
    const setMyCommands = vi.fn(async () => void 0);
    const runtimeLog = vi.fn();
    const accountId = `test-empty-delete-fail-${Date.now()}`;
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: [],
      accountId,
      botIdentity: "bot-a"
    });
    await vi.waitFor(() => expect(deleteMyCommands).toHaveBeenCalledTimes(1));
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: [],
      accountId,
      botIdentity: "bot-a"
    });
    await vi.waitFor(() => expect(deleteMyCommands).toHaveBeenCalledTimes(2));
  });
  it("retries with fewer commands on BOT_COMMANDS_TOO_MUCH", async () => {
    const deleteMyCommands = vi.fn(async () => void 0);
    const setMyCommands = vi.fn().mockRejectedValueOnce(new Error("400: Bad Request: BOT_COMMANDS_TOO_MUCH")).mockResolvedValue(void 0);
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      runtimeError,
      commandsToRegister: Array.from({ length: 100 }, (_, i) => ({
        command: `cmd_${i}`,
        description: `Command ${i}`
      })),
      accountId: `test-retry-${Date.now()}`,
      botIdentity: "bot-a"
    });
    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(2);
    });
    const firstPayload = setMyCommands.mock.calls[0]?.[0];
    const secondPayload = setMyCommands.mock.calls[1]?.[0];
    expect(firstPayload).toHaveLength(100);
    expect(secondPayload).toHaveLength(80);
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram rejected 100 commands (BOT_COMMANDS_TOO_MUCH); retrying with 80."
    );
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram accepted 80 commands after BOT_COMMANDS_TOO_MUCH (started with 100; omitted 20). Reduce plugin/skill/custom commands to expose more menu entries."
    );
    expect(runtimeError).not.toHaveBeenCalled();
  });
});
