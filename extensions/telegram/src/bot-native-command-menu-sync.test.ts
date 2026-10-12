// Telegram tests cover native command menu remote synchronization.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncTelegramMenuCommands } from "./bot-native-command-menu.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

function waitForTelegramMenu(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 1 });
}

function waitForTelegramMenuTurn() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

const ledgerRows = new Map<string, unknown>();
const ledgerRegisterCalls: Array<{ key: string; value: unknown }> = [];
const ledgerDeleteCalls: string[] = [];
let nextLedgerRegisterError: Error | undefined;
let nextBotId = 1_000_000;
const testBotIds = new Map<string, number>();

function createLedgerStore<T>(): PluginStateKeyedStore<T> {
  return {
    register: async (key, value) => {
      ledgerRegisterCalls.push({ key, value });
      if (nextLedgerRegisterError) {
        const error = nextLedgerRegisterError;
        nextLedgerRegisterError = undefined;
        throw error;
      }
      ledgerRows.set(key, value);
    },
    registerIfAbsent: async (key, value) => {
      if (ledgerRows.has(key)) {
        return false;
      }
      ledgerRows.set(key, value);
      return true;
    },
    lookup: async (key) => ledgerRows.get(key) as T | undefined,
    consume: async (key) => {
      const value = ledgerRows.get(key) as T | undefined;
      ledgerRows.delete(key);
      return value;
    },
    delete: async (key) => {
      ledgerDeleteCalls.push(key);
      return ledgerRows.delete(key);
    },
    entries: async () => [],
    clear: async () => ledgerRows.clear(),
  };
}

type SyncMenuOptions = {
  deleteMyCommands: ReturnType<typeof vi.fn>;
  setMyCommands: ReturnType<typeof vi.fn>;
  commandsToRegister: Parameters<typeof syncTelegramMenuCommands>[0]["commandsToRegister"];
  accountId: string;
  botIdentity?: string;
  botToken?: string;
  botId?: number;
  runtimeLog?: ReturnType<typeof vi.fn>;
  runtimeError?: ReturnType<typeof vi.fn>;
};

function resolveTestBotToken(options: SyncMenuOptions): string {
  if (options.botToken) {
    return options.botToken;
  }
  const identity = `${options.accountId}:${options.botIdentity ?? "default"}`;
  let botId = testBotIds.get(identity);
  if (!botId) {
    botId = nextBotId++;
    testBotIds.set(identity, botId);
  }
  return `${botId}:test-token`;
}

function syncMenuCommandsWithMocks(options: SyncMenuOptions): Promise<void> {
  const api = {
    deleteMyCommands: options.deleteMyCommands,
    setMyCommands: options.setMyCommands,
  };
  return syncTelegramMenuCommands({
    bot: { api } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
    runtime: {
      log: options.runtimeLog ?? vi.fn(),
      error: options.runtimeError ?? vi.fn(),
      exit: vi.fn(),
    } as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
    commandsToRegister: options.commandsToRegister,
    accountId: options.accountId,
    botId: options.botId,
    botToken: resolveTestBotToken(options),
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

function readLanguageCodeFromApiCall(call: readonly unknown[]): unknown {
  const options = call.at(-1);
  return options && typeof options === "object" && "language_code" in options
    ? options.language_code
    : undefined;
}

beforeEach(() => {
  ledgerRows.clear();
  ledgerRegisterCalls.length = 0;
  ledgerDeleteCalls.length = 0;
  nextLedgerRegisterError = undefined;
  const openKeyedStore = (<T>() =>
    createLedgerStore<T>()) as TelegramRuntime["state"]["openKeyedStore"];
  setTelegramRuntime({ state: { openKeyedStore }, channel: {} } as TelegramRuntime);
});

afterEach(() => {
  clearTelegramRuntimeForTest();
});

describe("bot-native-command-menu sync lifecycle", () => {
  it("registers localized command descriptions per Telegram language scope", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeLog = vi.fn();
    const commands = [
      {
        command: "cmd",
        description: "Default",
        descriptionLocalizations: {
          " KO ": "한국어",
          "en-GB": "British English is unsupported by Telegram",
          zz: "Unassigned language code",
        },
      },
    ];

    await syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId: `test-localized-${Date.now()}`,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    expect(deleteMyCommands).toHaveBeenCalledTimes(2);
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
      "Telegram command menu ignored unsupported description localization codes: en-GB, zz.",
    );
    expect(
      [...deleteMyCommands.mock.calls, ...setMyCommands.mock.calls].every((call) => {
        const languageCode = readLanguageCodeFromApiCall(call);
        return languageCode !== "zz" && languageCode !== "en-GB";
      }),
    ).toBe(true);
  });

  it("uses neutral descriptions only for blank commands in a sibling-provided locale", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);

    await syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      accountId: `test-sibling-localization-${Date.now()}`,
      botToken: "876543214:test-token",
      commandsToRegister: [
        {
          command: "blank",
          description: "Neutral blank",
          descriptionLocalizations: { fr: " " },
        },
        {
          command: "localized",
          description: "Neutral localized",
          descriptionLocalizations: { " FR ": " Français ", fr: "Duplicate" },
        },
      ],
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    expect(setMyCommandsPayload(setMyCommands, 2)).toEqual([
      { command: "blank", description: "Neutral blank" },
      { command: "localized", description: "Français" },
    ]);
  });

  it("preserves canonical source order under localization-only pressure", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const localizedDescription = "한".repeat(250);
    const canonical = Array.from({ length: 22 }, (_, index) => ({
      command: `canonical_${index}`,
      description: `Canonical ${index}`,
      descriptionLocalizations: { ko: localizedDescription },
    }));

    await syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [
        {
          command: "configured",
          description: "Configured",
          descriptionLocalizations: { ko: localizedDescription },
        },
        ...canonical,
        {
          command: "late_alias",
          description: "Alias",
          descriptionLocalizations: { ko: localizedDescription },
          isAlias: true,
        },
      ],
      accountId: `test-localized-pressure-${Date.now()}`,
    });

    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
    for (const index of [2, 3]) {
      // Captured setMyCommands payloads are grammY BotCommand arrays.
      const localized = setMyCommandsPayload(setMyCommands, index) as Array<{
        command: string;
        description: string;
      }>;
      const names = localized.map(({ command }) => command);
      expect(names).toHaveLength(24);
      expect(names.slice(0, 2)).toEqual(["configured", "canonical_0"]);
      expect(names.slice(-2)).toEqual(["canonical_21", "late_alias"]);
      expect(localized.every(({ description }) => description.length < 250)).toBe(true);
    }
  });

  it("resyncs when command order changes (#32017)", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const commands = [
      { command: "bravo", description: "B" },
      { command: "alpha", description: "A" },
    ];
    const accountId = `test-order-stable-${Date.now()}`;

    await syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: commands,
      accountId,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));
    await syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: commands.toReversed(),
      accountId,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    expect(deleteMyCommands).toHaveBeenCalledTimes(4);
  });

  it("does not cache empty-menu hash when deleteMyCommands fails", async () => {
    const deleteMyCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValue(undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const accountId = `test-empty-delete-fail-${Date.now()}`;

    await syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [],
      accountId,
    });
    await waitForTelegramMenu(() => expect(deleteMyCommands).toHaveBeenCalledTimes(2));
    await syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [],
      accountId,
    });
    await waitForTelegramMenu(() => expect(deleteMyCommands).toHaveBeenCalledTimes(4));
  });

  it.each([
    {
      label: "100→80→64 refill after partial skill retention",
      nativeCount: 57,
      skillCount: 20,
      pluginCount: 20,
      rejections: 2,
      acceptedCount: 64,
      acceptedPluginTail: ["plugin_0", "plugin_1", "plugin_2", "plugin_3"],
    },
  ])("publishes both scopes after $label without reporting a recovered error", async (testCase) => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    for (let attempt = 0; attempt < testCase.rejections; attempt++) {
      setMyCommands.mockRejectedValueOnce(new Error("400: Bad Request: BOT_COMMANDS_TOO_MUCH"));
    }
    const runtimeError = vi.fn();
    await syncMenuCommandsWithMocks({
      deleteMyCommands: vi.fn(async () => undefined),
      setMyCommands,
      runtimeError,
      commandsToRegister: [
        { command: "custom_one", description: "Custom one" },
        { command: "custom_two", description: "Custom two" },
        ...Array.from({ length: testCase.nativeCount }, (_, index) => ({
          command: `native_${index}`,
          description: `Native ${index}`,
        })),
        { command: "skill", description: "Run a skill" },
        ...Array.from({ length: testCase.skillCount }, (_, index) => ({
          command: `skill_${index}`,
          description: `Skill ${index}`,
          isSkill: true,
        })),
        ...Array.from({ length: testCase.pluginCount }, (_, index) => ({
          command: `plugin_${index}`,
          description: `Plugin ${index}`,
        })),
      ],
      accountId: `test-skill-retry-${testCase.label}-${Date.now()}`,
    });
    await waitForTelegramMenu(() =>
      expect(setMyCommands).toHaveBeenCalledTimes(testCase.rejections + 2),
    );
    expect(setMyCommandsPayload(setMyCommands, 0)).toHaveLength(100);
    if (testCase.rejections === 2) {
      // Captured setMyCommands payloads are grammY BotCommand arrays.
      const firstRetry = setMyCommandsPayload(setMyCommands, 1) as Array<{ command: string }>;
      expect(firstRetry).toHaveLength(80);
      expect(firstRetry.filter(({ command }) => command.startsWith("skill_"))).toHaveLength(20);
      expect(firstRetry.some(({ command }) => command.startsWith("plugin_"))).toBe(false);
    }

    for (const index of [testCase.rejections, testCase.rejections + 1]) {
      const accepted = setMyCommandsPayload(setMyCommands, index) as Array<{ command: string }>;
      const names = accepted.map(({ command }) => command);
      expect(names).toHaveLength(testCase.acceptedCount);
      expect(names.slice(0, 4)).toEqual(["skill", "custom_one", "custom_two", "native_0"]);
      expect(names[testCase.nativeCount + 2]).toBe(`native_${testCase.nativeCount - 1}`);
      expect(names.some((command) => command.startsWith("skill_"))).toBe(false);
      expect(names.filter((command) => command.startsWith("plugin_"))).toEqual(
        testCase.acceptedPluginTail,
      );
    }
    expect(setMyCommandsCall(setMyCommands, testCase.rejections).at(1)).toBeUndefined();
    expect(setMyCommandsCall(setMyCommands, testCase.rejections + 1).at(1)).toEqual({
      scope: { type: "all_group_chats" },
    });
    expect(runtimeError).not.toHaveBeenCalled();
  });

  it("clears removed localized scope pairs in one strictly serialized generation", async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const record = async (
      kind: string,
      options?: { scope?: { type?: string }; language_code?: string },
    ) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(
        `${kind}:${options?.language_code ?? "neutral"}:${options?.scope?.type ?? "default"}`,
      );
      await Promise.resolve();
      active -= 1;
    };
    const deleteMyCommands = vi.fn(async (options) => record("delete", options));
    const setMyCommands = vi.fn(async (_commands, options) => record("set", options));
    const accountId = `test-locale-removal-${Date.now()}`;

    await syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      accountId,
      commandsToRegister: [
        {
          command: "cmd",
          description: "Default",
          descriptionLocalizations: { fr: "Français", ko: "한국어" },
        },
      ],
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(6));
    events.length = 0;
    deleteMyCommands.mockClear();
    setMyCommands.mockClear();

    await syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      accountId,
      commandsToRegister: [
        {
          command: "cmd",
          description: "Default",
          descriptionLocalizations: { ko: "한국어" },
        },
      ],
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    expect(events).toEqual([
      "delete:neutral:default",
      "delete:neutral:all_group_chats",
      "delete:fr:default",
      "delete:fr:all_group_chats",
      "delete:ko:default",
      "delete:ko:all_group_chats",
      "set:neutral:default",
      "set:neutral:all_group_chats",
      "set:ko:default",
      "set:ko:all_group_chats",
    ]);
    expect(maxActive).toBe(1);
  });

  it("retries failed localized cleanup instead of hash-caching it", async () => {
    let failFrenchGroupClear = false;
    const deleteMyCommands = vi.fn(
      async (options?: { scope?: { type?: string }; language_code?: string }) => {
        if (
          failFrenchGroupClear &&
          options?.language_code === "fr" &&
          options.scope?.type === "all_group_chats"
        ) {
          failFrenchGroupClear = false;
          throw new Error("localized cleanup failed");
        }
      },
    );
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeError = vi.fn();
    const accountId = `test-cleanup-retry-${Date.now()}`;

    await syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeError,
      accountId,
      commandsToRegister: [
        { command: "cmd", description: "Default", descriptionLocalizations: { fr: "Français" } },
      ],
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
    deleteMyCommands.mockClear();
    setMyCommands.mockClear();
    failFrenchGroupClear = true;

    const neutralCommands = [{ command: "cmd", description: "Default" }];
    await syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeError,
      accountId,
      commandsToRegister: neutralCommands,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));
    await syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeError,
      accountId,
      commandsToRegister: neutralCommands,
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    const frenchGroupClears = deleteMyCommands.mock.calls.filter(
      ([options]) => options?.language_code === "fr" && options?.scope?.type === "all_group_chats",
    );
    expect(frenchGroupClears).toHaveLength(2);
    expect(runtimeError).toHaveBeenCalled();
  });

  it("resets an unsalvageable malformed current ledger once and still completes reconciliation", async () => {
    const botId = "876543211";
    ledgerRows.set(botId, {
      version: 1,
      languageCodes: ["zz", "en-GB", 42],
      unexpected: true,
    });
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeError = vi.fn();
    const accountId = `test-reset-ledger-${Date.now()}`;
    const commandsToRegister = [{ command: "cmd", description: "Default" }];
    const sync = () =>
      syncMenuCommandsWithMocks({
        deleteMyCommands,
        setMyCommands,
        runtimeError,
        accountId,
        botToken: `${botId}:test-token`,
        commandsToRegister,
      });

    await sync();
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));
    expect(ledgerRows.has(botId)).toBe(false);
    expect(ledgerDeleteCalls).toEqual([botId]);
    expect(runtimeError).toHaveBeenCalledWith(
      `Telegram command menu locale ledger for bot ${botId} was reset; the unshipped ledger contained non-canonical data (discarded unsupported language codes: en-GB, zz; discarded 2 malformed ledger field(s) or entry(ies)).`,
    );

    await waitForTelegramMenuTurn();
    await sync();
    await waitForTelegramMenuTurn();

    expect(deleteMyCommands).toHaveBeenCalledTimes(2);
    expect(setMyCommands).toHaveBeenCalledTimes(2);
    expect(ledgerDeleteCalls).toEqual([botId]);
    expect(runtimeError).toHaveBeenCalledTimes(1);
  });

  it("preserves future locale-ledger versions and fails closed before Telegram API calls", async () => {
    const botId = "876543215";
    const futureLedger = { version: 2, languageCodes: [" FR ", "zz", 42], unexpected: true };
    const originalShape = structuredClone(futureLedger);
    ledgerRows.set(botId, futureLedger);
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeError = vi.fn();
    const sync = () =>
      syncMenuCommandsWithMocks({
        deleteMyCommands,
        setMyCommands,
        runtimeError,
        accountId: `test-future-ledger-${Date.now()}`,
        botToken: `${botId}:test-token`,
        commandsToRegister: [{ command: "cmd", description: "Default" }],
      });

    await sync();
    await waitForTelegramMenu(() => expect(runtimeError).toHaveBeenCalledTimes(1));
    await sync();
    await waitForTelegramMenu(() => expect(runtimeError).toHaveBeenCalledTimes(2));

    expect(ledgerRows.get(botId)).toBe(futureLedger);
    expect(ledgerRows.get(botId)).toEqual(originalShape);
    expect(ledgerRegisterCalls).toHaveLength(0);
    expect(ledgerDeleteCalls).toHaveLength(0);
    expect(deleteMyCommands).not.toHaveBeenCalled();
    expect(setMyCommands).not.toHaveBeenCalled();
    for (const [message] of runtimeError.mock.calls) {
      expect(message).toContain("unsupported future version 2");
      expect(message.length).toBeLessThanOrEqual(180);
    }
  });

  it("retries after a locale-ledger repair write fails", async () => {
    const botId = "876543212";
    const rawLedger = { version: 1, languageCodes: ["fr", "zz"] };
    ledgerRows.set(botId, rawLedger);
    nextLedgerRegisterError = new Error("injected repair failure");
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeError = vi.fn();
    const accountId = `test-retry-ledger-repair-${Date.now()}`;
    const commandsToRegister = [
      {
        command: "cmd",
        description: "Default",
        descriptionLocalizations: { ko: "한국어" },
      },
    ];
    const sync = () =>
      syncMenuCommandsWithMocks({
        deleteMyCommands,
        setMyCommands,
        runtimeError,
        accountId,
        botToken: `${botId}:test-token`,
        commandsToRegister,
      });

    await sync();
    await waitForTelegramMenu(() => expect(runtimeError).toHaveBeenCalledTimes(1));
    expect(ledgerRows.get(botId)).toBe(rawLedger);
    expect(deleteMyCommands).not.toHaveBeenCalled();
    expect(setMyCommands).not.toHaveBeenCalled();
    expect(runtimeError).toHaveBeenCalledWith(
      `Telegram command menu locale ledger repair failed for bot ${botId}: Error: injected repair failure`,
    );

    await sync();
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
    expect(deleteMyCommands).toHaveBeenCalledWith({ language_code: "fr" });
    expect(setMyCommands).toHaveBeenCalledWith([{ command: "cmd", description: "한국어" }], {
      language_code: "ko",
    });
    expect(ledgerRows.get(botId)).toEqual({ version: 1, languageCodes: ["ko"] });
    expect(runtimeError).toHaveBeenCalledWith(
      `Telegram command menu locale ledger for bot ${botId} was repaired; the unshipped ledger contained non-canonical data (discarded unsupported language codes: zz).`,
    );

    await waitForTelegramMenuTurn();
    await sync();
    await waitForTelegramMenuTurn();

    expect(deleteMyCommands).toHaveBeenCalledTimes(4);
    expect(setMyCommands).toHaveBeenCalledTimes(4);
    expect(ledgerRegisterCalls).toHaveLength(3);
    expect(runtimeError).toHaveBeenCalledTimes(2);
  });
});
