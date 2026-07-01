// Telegram tests cover bot native command menu plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  hashCommandList,
  syncTelegramMenuCommands,
  TELEGRAM_TOTAL_COMMAND_TEXT_BUDGET,
} from "./bot-native-command-menu.js";

type SyncMenuOptions = {
  deleteMyCommands: ReturnType<typeof vi.fn>;
  setMyCommands: ReturnType<typeof vi.fn>;
  getMyCommands?: ReturnType<typeof vi.fn>;
  commandsToRegister: Parameters<typeof syncTelegramMenuCommands>[0]["commandsToRegister"];
  accountId: string;
  botIdentity: string;
  runtimeLog?: ReturnType<typeof vi.fn>;
  runtimeError?: ReturnType<typeof vi.fn>;
};

function syncMenuCommandsWithMocks(options: SyncMenuOptions): void {
  syncTelegramMenuCommands({
    bot: {
      api: {
        deleteMyCommands: options.deleteMyCommands,
        setMyCommands: options.setMyCommands,
        ...(options.getMyCommands ? { getMyCommands: options.getMyCommands } : {}),
      },
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

function setMyCommandsCall(setMyCommands: ReturnType<typeof vi.fn>, index: number): unknown[] {
  const call = setMyCommands.mock.calls.at(index);
  if (!call) {
    throw new Error(`Expected setMyCommands call ${index}`);
  }
  return call;
}

function setMyCommandsPayload(
  setMyCommands: ReturnType<typeof vi.fn>,
  index: number,
): Array<unknown> {
  const payload = setMyCommandsCall(setMyCommands, index).at(0);
  if (!Array.isArray(payload)) {
    throw new Error(`Expected setMyCommands call ${index} to include a command payload`);
  }
  return payload;
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

  it("does not let aliases consume command slots before canonical commands", () => {
    const canonicalCommands = Array.from({ length: 100 }, (_, i) => ({
      command: `cmd_${i}`,
      description: `Command ${i}`,
    }));
    const allCommands = [
      ...canonicalCommands.slice(0, 99),
      { command: "side", description: "Alias", isAlias: true },
      canonicalCommands[99],
    ];

    const result = buildCappedTelegramMenuCommands({ allCommands });

    expect(result.commandsToRegister).toEqual(canonicalCommands);
    expect(result.totalCommands).toBe(101);
    expect(result.overflowCount).toBe(1);
  });

  it("preserves alias order when the Telegram command cap is not exceeded", () => {
    const allCommands = [
      { command: "btw", description: "Ask a side question" },
      { command: "side", description: "Alias", isAlias: true },
      { command: "plugin_command", description: "Plugin command" },
    ];

    const result = buildCappedTelegramMenuCommands({ allCommands });

    expect(result.commandsToRegister).toEqual([
      { command: "btw", description: "Ask a side question" },
      { command: "side", description: "Alias" },
      { command: "plugin_command", description: "Plugin command" },
    ]);
    expect(result.totalCommands).toBe(3);
    expect(result.overflowCount).toBe(0);
  });

  it("counts aliases dropped by the Telegram command cap", () => {
    const canonicalCommands = Array.from({ length: 99 }, (_, i) => ({
      command: `cmd_${i}`,
      description: `Command ${i}`,
    }));
    const aliasCommands = Array.from({ length: 5 }, (_, i) => ({
      command: `alias_${i}`,
      description: `Alias ${i}`,
      isAlias: true,
    }));

    const result = buildCappedTelegramMenuCommands({
      allCommands: [...canonicalCommands, ...aliasCommands],
    });

    expect(result.commandsToRegister).toEqual([
      ...canonicalCommands,
      { command: "alias_0", description: "Alias 0" },
    ]);
    expect(result.totalCommands).toBe(104);
    expect(result.overflowCount).toBe(4);
  });

  it("shortens descriptions before dropping commands to fit Telegram payload budget", () => {
    const allCommands = Array.from({ length: 92 }, (_, i) => ({
      command: `cmd_${i}`,
      description: "x".repeat(100),
    }));

    const result = buildCappedTelegramMenuCommands({ allCommands });

    expect(result.commandsToRegister).toHaveLength(92);
    expect(result.descriptionTrimmed).toBe(true);
    expect(result.textBudgetDropCount).toBe(0);
    const totalText = result.commandsToRegister.reduce(
      (total, command) => total + command.command.length + command.description.length,
      0,
    );
    expect(totalText).toBeLessThanOrEqual(TELEGRAM_TOTAL_COMMAND_TEXT_BUDGET);
    expect(result.commandsToRegister.filter((command) => command.description.length > 56)).toEqual(
      [],
    );
  });

  it("drops tail commands only when minimal descriptions still cannot fit the payload budget", () => {
    const allCommands = [
      { command: "alpha_cmd", description: "First command" },
      { command: "bravo_cmd", description: "Second command" },
      { command: "charlie_cmd", description: "Third command" },
    ];

    const result = buildCappedTelegramMenuCommands({
      allCommands,
      maxTotalChars: 20,
    });

    expect(result.commandsToRegister).toEqual([
      { command: "alpha_cmd", description: "F" },
      { command: "bravo_cmd", description: "S" },
    ]);
    expect(result.descriptionTrimmed).toBe(true);
    expect(result.textBudgetDropCount).toBe(1);
  });

  it("does not reuse cached capped results for delimiter-like descriptions", () => {
    const first = buildCappedTelegramMenuCommands({
      allCommands: [{ command: "a", description: "b\0c\0d" }],
    });
    const second = buildCappedTelegramMenuCommands({
      allCommands: [
        { command: "a", description: "b" },
        { command: "c", description: "d" },
      ],
    });

    expect(first.commandsToRegister).toEqual([{ command: "a", description: "b\0c\0d" }]);
    expect(second.commandsToRegister).toEqual([
      { command: "a", description: "b" },
      { command: "c", description: "d" },
    ]);
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

  it("preserves plugin command description localizations for Telegram menu sync", () => {
    const result = buildPluginTelegramMenuCommands({
      specs: [
        {
          name: "valid",
          description: "Works",
          descriptionLocalizations: { ko: "작동함" },
        },
      ],
      existingCommands: new Set<string>(),
    });

    expect(result.commands).toEqual([
      {
        command: "valid",
        description: "Works",
        descriptionLocalizations: { ko: "작동함" },
      },
    ]);
    expect(result.issues).toStrictEqual([]);
  });

  it("normalizes hyphenated plugin command names", () => {
    const result = buildPluginTelegramMenuCommands({
      specs: [{ name: "agent-run", description: "Run agent" }],
      existingCommands: new Set<string>(),
    });

    expect(result.commands).toEqual([{ command: "agent_run", description: "Run agent" }]);
    expect(result.issues).toStrictEqual([]);
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
    const deleteMyCommands = vi.fn(async (options?: { scope?: { type?: string } }) => {
      callOrder.push(options?.scope?.type ? `delete:${options.scope.type}` : "delete:default");
    });
    const setMyCommands = vi.fn(
      async (_commands: unknown, options?: { scope?: { type?: string } }) => {
        callOrder.push(options?.scope?.type ? `set:${options.scope.type}` : "set:default");
      },
    );

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

    expect(callOrder).toEqual([
      "delete:default",
      "delete:all_group_chats",
      "set:default",
      "set:all_group_chats",
    ]);
  });

  it("registers the menu in default and group chat scopes", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const commands = [{ command: "cmd", description: "Command" }];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: commands,
      accountId: `test-scopes-${Date.now()}`,
      botIdentity: "bot-a",
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(2);
    });

    expect(setMyCommands).toHaveBeenCalledWith(commands);
    expect(setMyCommands).toHaveBeenCalledWith(commands, {
      scope: { type: "all_group_chats" },
    });
  });

  it("registers localized command descriptions per Telegram language scope", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeLog = vi.fn();
    const commands = [
      {
        command: "cmd",
        description: "Default",
        descriptionLocalizations: {
          ko: "한국어",
          "en-GB": "British English is unsupported by Telegram",
        },
      },
    ];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId: `test-localized-${Date.now()}`,
      botIdentity: "bot-a",
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(4);
    });

    expect(setMyCommandsPayload(setMyCommands, 0)).toEqual([
      { command: "cmd", description: "Default" },
    ]);
    expect(setMyCommandsPayload(setMyCommands, 2)).toEqual([
      { command: "cmd", description: "한국어" },
    ]);
    expect(setMyCommandsCall(setMyCommands, 2).at(1)).toEqual({ language_code: "ko" });
    expect(setMyCommandsCall(setMyCommands, 3).at(1)).toEqual({
      scope: { type: "all_group_chats" },
      language_code: "ko",
    });
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram command menu ignored unsupported description localization codes: en-GB.",
    );
  });

  it("caps localized command descriptions before registering Telegram variants", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [
        {
          command: "long",
          description: "Default",
          descriptionLocalizations: { ko: "x".repeat(300) },
        },
      ],
      accountId: `test-localized-cap-${Date.now()}`,
      botIdentity: "bot-a",
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(4);
    });

    const localizedPayload = setMyCommandsPayload(setMyCommands, 2);
    expect(localizedPayload[0]).toMatchObject({ command: "long" });
    expect((localizedPayload[0] as { description: string }).description).toHaveLength(256);
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

  it("produces different hashes for delimiter-like command lists", () => {
    const a = [{ command: "a", description: "b\0c\0d" }];
    const b = [
      { command: "a", description: "b" },
      { command: "c", description: "d" },
    ];
    expect(hashCommandList(a)).not.toBe(hashCommandList(b));
  });

  it("cached-hash skips sync when default and group remote command states are populated (#32017)", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const getMyCommands = vi.fn(async () => [
      { command: "skip_test", description: "Skip test command" },
    ]);
    const runtimeLog = vi.fn();

    const accountId = `test-skip-${Date.now()}`;
    const commands = [{ command: "skip_test", description: "Skip test command" }];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      getMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-a",
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(2);
    });

    // Second sync: hash matches and every remote scope is non-empty.
    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      getMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-a",
    });

    // No additional calls — sync was skipped
    await vi.waitFor(() => {
      expect(getMyCommands).toHaveBeenCalled();
    });
    expect(setMyCommands).toHaveBeenCalledTimes(2);
    expect(getMyCommands).toHaveBeenCalledWith(undefined);
    expect(getMyCommands).toHaveBeenCalledWith({ scope: { type: "all_group_chats" } });
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
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(2));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "token-bot-b",
    });
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
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
    await vi.waitFor(() => expect(deleteMyCommands).toHaveBeenCalledTimes(2));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: [],
      accountId,
      botIdentity: "bot-a",
    });
    await vi.waitFor(() => expect(deleteMyCommands).toHaveBeenCalledTimes(4));
  });

  it("cached-hash skips sync after empty menu deletes successfully (#32017)", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const getMyCommands = vi.fn(async () => []);
    const accountId = `test-empty-delete-cache-${Date.now()}`;

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      getMyCommands,
      commandsToRegister: [],
      accountId,
      botIdentity: "bot-a",
    });
    await vi.waitFor(() => expect(deleteMyCommands).toHaveBeenCalledTimes(2));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      getMyCommands,
      commandsToRegister: [],
      accountId,
      botIdentity: "bot-a",
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(deleteMyCommands).toHaveBeenCalledTimes(2);
    expect(setMyCommands).not.toHaveBeenCalled();
    expect(getMyCommands).not.toHaveBeenCalled();
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
      expect(setMyCommands).toHaveBeenCalledTimes(3);
    });
    const firstPayload = setMyCommandsPayload(setMyCommands, 0);
    const secondPayload = setMyCommandsPayload(setMyCommands, 1);
    const thirdPayload = setMyCommandsPayload(setMyCommands, 2);
    expect(firstPayload).toHaveLength(100);
    expect(secondPayload).toHaveLength(80);
    expect(thirdPayload).toHaveLength(80);
    expect(setMyCommandsCall(setMyCommands, 2).at(1)).toEqual({
      scope: { type: "all_group_chats" },
    });
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram rejected 100 commands (BOT_COMMANDS_TOO_MUCH); retrying with 80.",
    );
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram accepted 80 commands after BOT_COMMANDS_TOO_MUCH (started with 100; omitted 20). Reduce plugin/skill/custom commands to expose more menu entries.",
    );
    expect(runtimeError).not.toHaveBeenCalled();
  });

  it("registers localized variants from the accepted retry command set", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error("400: Bad Request: BOT_COMMANDS_TOO_MUCH"))
      .mockResolvedValue(undefined);

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: Array.from({ length: 100 }, (_, i) => ({
        command: `cmd_${i}`,
        description: `Command ${i}`,
        descriptionLocalizations: { ko: `명령 ${i}` },
      })),
      accountId: `test-localized-retry-${Date.now()}`,
      botIdentity: "bot-a",
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(5);
    });
    expect(setMyCommandsPayload(setMyCommands, 0)).toHaveLength(100);
    expect(setMyCommandsPayload(setMyCommands, 1)).toHaveLength(80);
    expect(setMyCommandsPayload(setMyCommands, 3)).toHaveLength(80);
    expect(setMyCommandsCall(setMyCommands, 3).at(1)).toEqual({ language_code: "ko" });
  });

  it("cached-hash verifier ignores retry-omitted localized variants", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error("400: Bad Request: BOT_COMMANDS_TOO_MUCH"))
      .mockResolvedValue(undefined);
    const getMyCommands = vi.fn(
      async (opts?: { scope?: { type?: string }; language_code?: string }) =>
        opts?.language_code === "ko" ? [] : [{ command: "cmd_0", description: "Command 0" }],
    );
    const accountId = `test-retry-omitted-localized-${Date.now()}`;
    const commands = Array.from({ length: 100 }, (_, i) => ({
      command: `cmd_${i}`,
      description: `Command ${i}`,
      ...(i >= 80 ? { descriptionLocalizations: { ko: `명령 ${i}` } } : undefined),
    }));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      getMyCommands,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-a",
    });
    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(3);
    });

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      getMyCommands,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-a",
    });
    await vi.waitFor(() => {
      expect(getMyCommands).toHaveBeenCalledTimes(2);
    });
    expect(getMyCommands).not.toHaveBeenCalledWith({ language_code: "ko" });
    expect(getMyCommands).not.toHaveBeenCalledWith({
      scope: { type: "all_group_chats" },
      language_code: "ko",
    });
    expect(deleteMyCommands).toHaveBeenCalledTimes(2);
    expect(setMyCommands).toHaveBeenCalledTimes(3);
  });

  it.each([
    { label: "description envelope", error: { description: "BOT_COMMANDS_TOO_MUCH" } },
    { label: "message envelope", error: { message: "BOT_COMMANDS_TOO_MUCH" } },
  ])("retries when Telegram returns a plain-object $label error", async ({ error }) => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const runtimeLog = vi.fn();

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: Array.from({ length: 10 }, (_, i) => ({
        command: `cmd_${i}`,
        description: `Command ${i}`,
      })),
      accountId: `test-envelope-${Date.now()}`,
      botIdentity: "bot-a",
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(3);
    });
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram rejected 10 commands (BOT_COMMANDS_TOO_MUCH); retrying with 8.",
    );
  });

  it("cached-hash re-syncs when default remote command state is empty despite matching hash (#92944)", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const getMyCommands = vi.fn(async () => []);
    const runtimeLog = vi.fn();
    const accountId = `test-empty-remote-${Date.now()}`;
    const commands = [{ command: "test", description: "Test" }];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      getMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-a",
    });
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(2));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      getMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-a",
    });
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
    expect(getMyCommands).toHaveBeenCalled();
  });

  it("cached-hash re-syncs when group remote command state is empty despite matching hash (#92944)", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const getMyCommands = vi.fn(async (opts?: { scope?: { type?: string } }) =>
      opts?.scope?.type === "all_group_chats" ? [] : [{ command: "test", description: "Test" }],
    );
    const runtimeLog = vi.fn();
    const accountId = `test-empty-group-remote-${Date.now()}`;
    const commands = [{ command: "test", description: "Test" }];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      getMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-group",
    });
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(2));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      getMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-group",
    });
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
    expect(getMyCommands).toHaveBeenCalledWith(undefined);
    expect(getMyCommands).toHaveBeenCalledWith({ scope: { type: "all_group_chats" } });
  });

  it("cached-hash skips sync when remote command state is non-empty and hash matches", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const getMyCommands = vi.fn(async () => [{ command: "test", description: "Test" }]);
    const runtimeLog = vi.fn();
    const accountId = `test-populated-remote-${Date.now()}`;
    const commands = [{ command: "test", description: "Test" }];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      getMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-b",
    });
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(2));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      getMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-b",
    });
    await vi.waitFor(() => {
      expect(getMyCommands).toHaveBeenCalled();
    });
    expect(setMyCommands).toHaveBeenCalledTimes(2);
  });

  it("cached-hash re-syncs when localized command variant is empty despite base scopes being populated (#92945)", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const getMyCommands = vi.fn(async (opts?: { language_code?: string }) => {
      if (opts?.language_code === "ko") {
        return [];
      }
      return [{ command: "test", description: "Test" }];
    });
    const runtimeLog = vi.fn();
    const accountId = `test-localized-empty-${Date.now()}`;
    const commands = [
      {
        command: "test",
        description: "Test",
        descriptionLocalizations: { ko: "테스트" },
      },
    ];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      getMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-c",
    });
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      getMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-c",
    });
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(8));
    const langCodeCalls = getMyCommands.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.language_code === "ko",
    );
    expect(langCodeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("cached-hash re-syncs when localized group command variant is empty (#92945)", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const getMyCommands = vi.fn(
      async (opts?: { scope?: { type?: string }; language_code?: string }) =>
        opts?.scope?.type === "all_group_chats" && opts.language_code === "ko"
          ? []
          : [{ command: "test", description: "Test" }],
    );
    const runtimeLog = vi.fn();
    const accountId = `test-localized-group-empty-${Date.now()}`;
    const commands = [
      {
        command: "test",
        description: "Test",
        descriptionLocalizations: { ko: "테스트" },
      },
    ];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      getMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-d",
    });
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      getMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-d",
    });
    await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(8));
    expect(getMyCommands).toHaveBeenCalledWith({
      scope: { type: "all_group_chats" },
      language_code: "ko",
    });
  });
});
