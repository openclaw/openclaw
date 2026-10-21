import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncTelegramMenuCommands } from "./bot-native-command-menu.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

function waitForTelegramMenu(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 1 });
}

const ledgerRows = new Map<string, unknown>();
const ledgerRegisterCalls: Array<{ key: string; value: unknown }> = [];
const ledgerDeleteCalls: string[] = [];
let nextBotId = 1_000_000;

function createLedgerStore<T>(): PluginStateKeyedStore<T> {
  return {
    register: async (key, value) => {
      ledgerRegisterCalls.push({ key, value });
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

type MenuCommands = Parameters<typeof syncTelegramMenuCommands>[0]["commandsToRegister"];
type MenuScope = { scope?: { type?: string }; language_code?: string };
function createMenu(botToken = `${nextBotId++}:test-token`) {
  const deleteMyCommands = vi.fn(async (_options?: MenuScope): Promise<void> => undefined);
  const setMyCommands = vi.fn(
    async (_commands: MenuCommands, _options?: MenuScope): Promise<void> => undefined,
  );
  const runtimeLog = vi.fn();
  const runtimeError = vi.fn();
  return {
    deleteMyCommands,
    setMyCommands,
    runtimeLog,
    runtimeError,
    sync: (commandsToRegister: MenuCommands) =>
      syncTelegramMenuCommands({
        bot: { api: { deleteMyCommands, setMyCommands } } as unknown as Parameters<
          typeof syncTelegramMenuCommands
        >[0]["bot"],
        runtime: { log: runtimeLog, error: runtimeError, exit: vi.fn() } as Parameters<
          typeof syncTelegramMenuCommands
        >[0]["runtime"],
        accountId: botToken,
        botToken,
        commandsToRegister,
      }),
  };
}

const makeCommand = (descriptionLocalizations?: Record<string, string>) => ({
  command: "cmd",
  description: "Default",
  ...(descriptionLocalizations ? { descriptionLocalizations } : {}),
});

type MenuMock = ReturnType<typeof createMenu>["setMyCommands"];
function setMyCommandsCall(setMyCommands: MenuMock, index: number) {
  const call = setMyCommands.mock.calls.at(index);
  if (!call) {
    throw new Error(`Expected setMyCommands call ${index}`);
  }
  return call;
}

const setMyCommandsPayload = (mock: MenuMock, index: number) => setMyCommandsCall(mock, index)[0];

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
  const openKeyedStore = (<T>() =>
    createLedgerStore<T>()) as TelegramRuntime["state"]["openKeyedStore"];
  setTelegramRuntime({ state: { openKeyedStore }, channel: {} } as TelegramRuntime);
});

afterEach(() => {
  clearTelegramRuntimeForTest();
});

describe("bot-native-command-menu sync lifecycle", () => {
  it("registers localized command descriptions per Telegram language scope", async () => {
    const { deleteMyCommands, setMyCommands, runtimeLog, sync } = createMenu();
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

    await sync(commands);
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
    const { setMyCommands, sync } = createMenu("876543214:test-token");
    await sync([
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
    ]);
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    expect(setMyCommandsPayload(setMyCommands, 2)).toEqual([
      { command: "blank", description: "Neutral blank" },
      { command: "localized", description: "Français" },
    ]);
  });

  it("preserves canonical source order under localization-only pressure", async () => {
    const { setMyCommands, sync } = createMenu();
    const localizedDescription = "한".repeat(250);
    const canonical = Array.from({ length: 22 }, (_, index) => ({
      command: `canonical_${index}`,
      description: `Canonical ${index}`,
      descriptionLocalizations: { ko: localizedDescription },
    }));

    await sync([
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
    ]);

    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
    for (const index of [2, 3]) {
      const localized = setMyCommandsPayload(setMyCommands, index);
      const names = localized.map(({ command }) => command);
      expect(names).toHaveLength(24);
      expect(names.slice(0, 2)).toEqual(["configured", "canonical_0"]);
      expect(names.slice(-2)).toEqual(["canonical_21", "late_alias"]);
      expect(localized.every(({ description }) => description.length < 250)).toBe(true);
    }
  });

  it("resyncs when command order changes (#32017)", async () => {
    const { deleteMyCommands, setMyCommands, sync } = createMenu();
    const commands = [
      { command: "bravo", description: "B" },
      { command: "alpha", description: "A" },
    ];
    await sync(commands);
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));
    await sync(commands.toReversed());
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    expect(deleteMyCommands).toHaveBeenCalledTimes(4);
  });

  it("does not cache empty-menu hash when deleteMyCommands fails", async () => {
    const { deleteMyCommands, sync } = createMenu();
    deleteMyCommands
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValue(undefined);
    await sync([]);
    await waitForTelegramMenu(() => expect(deleteMyCommands).toHaveBeenCalledTimes(2));
    await sync([]);
    await waitForTelegramMenu(() => expect(deleteMyCommands).toHaveBeenCalledTimes(4));
  });

  it("publishes both scopes after 100→80→64 refill without reporting a recovered error", async () => {
    const { setMyCommands, runtimeError, sync } = createMenu();
    for (let attempt = 0; attempt < 2; attempt++) {
      setMyCommands.mockRejectedValueOnce(new Error("400: Bad Request: BOT_COMMANDS_TOO_MUCH"));
    }
    const commands = (prefix: string, description: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        command: `${prefix}_${index}`,
        description: `${description} ${index}`,
        ...(prefix === "skill" ? { isSkill: true } : {}),
      }));
    await sync([
      { command: "custom_one", description: "Custom one" },
      { command: "custom_two", description: "Custom two" },
      ...commands("native", "Native", 57),
      { command: "skill", description: "Run a skill" },
      ...commands("skill", "Skill", 20),
      ...commands("plugin", "Plugin", 20),
    ]);
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
    expect(setMyCommandsPayload(setMyCommands, 0)).toHaveLength(100);
    const firstRetry = setMyCommandsPayload(setMyCommands, 1);
    expect(firstRetry).toHaveLength(80);
    expect(firstRetry.filter(({ command }) => command.startsWith("skill_"))).toHaveLength(20);
    expect(firstRetry.some(({ command }) => command.startsWith("plugin_"))).toBe(false);

    for (const index of [2, 3]) {
      const accepted = setMyCommandsPayload(setMyCommands, index);
      const names = accepted.map(({ command }) => command);
      expect(names).toHaveLength(64);
      expect(names.slice(0, 4)).toEqual(["skill", "custom_one", "custom_two", "native_0"]);
      expect(names[59]).toBe("native_56");
      expect(names.some((command) => command.startsWith("skill_"))).toBe(false);
      expect(names.filter((command) => command.startsWith("plugin_"))).toEqual([
        "plugin_0",
        "plugin_1",
        "plugin_2",
        "plugin_3",
      ]);
    }
    expect(setMyCommandsCall(setMyCommands, 2).at(1)).toBeUndefined();
    expect(setMyCommandsCall(setMyCommands, 3).at(1)).toEqual({
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
    const { deleteMyCommands, setMyCommands, sync } = createMenu();
    deleteMyCommands.mockImplementation(async (options) => record("delete", options));
    setMyCommands.mockImplementation(async (_commands, options) => record("set", options));
    await sync([makeCommand({ fr: "Français", ko: "한국어" })]);
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(6));
    events.length = 0;
    deleteMyCommands.mockClear();
    setMyCommands.mockClear();

    await sync([makeCommand({ ko: "한국어" })]);
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
    const { deleteMyCommands, setMyCommands, runtimeError, sync } = createMenu();
    deleteMyCommands.mockImplementation(
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
    await sync([makeCommand({ fr: "Français" })]);
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
    deleteMyCommands.mockClear();
    setMyCommands.mockClear();
    failFrenchGroupClear = true;

    const neutralCommands = [makeCommand()];
    await sync(neutralCommands);
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));
    await sync(neutralCommands);
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    const frenchGroupClears = deleteMyCommands.mock.calls.filter(
      ([options]) => options?.language_code === "fr" && options?.scope?.type === "all_group_chats",
    );
    expect(frenchGroupClears).toHaveLength(2);
    expect(runtimeError).toHaveBeenCalled();
  });

  it("uses valid cached locales without a separate repair write", async () => {
    const botId = "876543211";
    ledgerRows.set(botId, {
      version: 1,
      languageCodes: [" FR ", "zz", "en-GB", 42],
      unexpected: true,
    });
    const { deleteMyCommands, setMyCommands, runtimeError, sync } = createMenu(
      `${botId}:test-token`,
    );
    await sync([makeCommand({ ko: "한국어" })]);
    expect(setMyCommands).toHaveBeenCalledTimes(4);
    expect(deleteMyCommands).toHaveBeenCalledWith({ language_code: "fr" });
    expect(deleteMyCommands).toHaveBeenCalledTimes(4);
    expect(ledgerRows.get(botId)).toEqual({ version: 1, languageCodes: ["ko"] });
    expect(ledgerRegisterCalls).toEqual([
      { key: botId, value: { version: 1, languageCodes: ["ko"] } },
    ]);
    expect(runtimeError).not.toHaveBeenCalled();
  });

  it("preserves future locale-ledger versions and fails closed before Telegram API calls", async () => {
    const botId = "876543215";
    const futureLedger = { version: 2, languageCodes: [" FR ", "zz", 42], unexpected: true };
    const originalShape = structuredClone(futureLedger);
    ledgerRows.set(botId, futureLedger);
    const { deleteMyCommands, setMyCommands, runtimeError, sync } = createMenu(
      `${botId}:test-token`,
    );
    await sync([makeCommand()]);
    await waitForTelegramMenu(() => expect(runtimeError).toHaveBeenCalledTimes(1));
    await sync([makeCommand()]);
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
});
