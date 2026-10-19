import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import {
  deleteTelegramUpdateOffset,
  prepareTelegramAccount,
  readTelegramUpdateOffset,
  writeTelegramUpdateOffset,
  type TelegramAccountRotationInfo,
} from "./update-offset-store.js";

describe("deleteTelegramUpdateOffset", () => {
  let updateOffsetStore: PluginStateKeyedStore<unknown>;
  const createStore = () =>
    createPluginStateKeyedStoreForTests<unknown>("telegram", {
      namespace: "telegram.update-offsets",
      maxEntries: 1_000,
    });
  const writeOffset = (updateId: number, botToken?: string) =>
    writeTelegramUpdateOffset({ accountId: "default", updateId, botToken });
  const state = (lastUpdateId: unknown, botId: string | null) => ({
    version: 3,
    lastUpdateId,
    botId,
    tokenFingerprint: null,
  });

  async function expectRotation(botToken: string, expected: TelegramAccountRotationInfo) {
    const onRotationDetected = vi.fn();
    const offset = await readTelegramUpdateOffset({
      accountId: "default",
      botToken,
      onRotationDetected,
    });
    expect(offset).toBeNull();
    expect(onRotationDetected.mock.calls).toEqual([[expected]]);
  }

  function installStore(store: PluginStateKeyedStore<unknown>): void {
    updateOffsetStore = store;
    setTelegramRuntime({
      state: {
        openKeyedStore: (() => updateOffsetStore) as TelegramRuntime["state"]["openKeyedStore"],
      },
      channel: {},
    } as TelegramRuntime);
  }

  beforeEach(async () => {
    installStore(createStore());
    await updateOffsetStore.clear();
  });

  afterEach(() => {
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
  });

  it("only removes the targeted account offset, leaving others intact", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeTelegramUpdateOffset({ accountId: "default", updateId: 100 });
      await writeTelegramUpdateOffset({ accountId: "alerts", updateId: 200 });

      await deleteTelegramUpdateOffset({ accountId: "default" });

      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
      expect(await readTelegramUpdateOffset({ accountId: "alerts" })).toBe(200);
    });
  });

  it("surfaces plugin-state write failures", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      installStore({
        ...createStore(),
        async register() {
          throw new Error("store write failed");
        },
      });

      await expect(writeOffset(808)).rejects.toThrow("store write failed");
    });
  });

  it("invokes onRotationDetected when the stored bot id no longer matches", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeOffset(1500, "111111:token-a");
      await expectRotation("222222:token-b", {
        reason: "bot-id-changed",
        previousBotId: "111111",
        currentBotId: "222222",
        staleLastUpdateId: 1500,
      });
    });
  });

  it("invokes onRotationDetected for canonical offsets without bot identity", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await updateOffsetStore.register("default", state(777, null));
      await expectRotation("333333:token-c", {
        reason: "legacy-state",
        previousBotId: null,
        currentBotId: "333333",
        staleLastUpdateId: 777,
      });
    });
  });

  it("tolerates read-only lookup failures but refuses account preparation without identity", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      installStore({
        ...createStore(),
        async lookup() {
          throw new Error("store unavailable");
        },
      });

      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBeNull();
      await expect(
        prepareTelegramAccount({
          accountId: "primary",
          botToken: "111111:fixture",
          onRotationDetected: () => {},
        }),
      ).rejects.toThrow(/account "primary".*restart.*store unavailable/);
    });
  });

  it("detects same-bot token rotation via the persisted fingerprint", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      const original = "111111:original-secret";
      await writeOffset(42, original);

      expect(await readTelegramUpdateOffset({ accountId: "default", botToken: original })).toBe(42);

      await expectRotation("111111:rotated-secret", {
        reason: "token-rotated",
        previousBotId: "111111",
        currentBotId: "111111",
        staleLastUpdateId: 42,
      });
    });
  });

  it("treats canonical bot-id-only offsets as stale when token identity cannot be verified", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await updateOffsetStore.register("default", state(999, "111111"));
      await expectRotation("111111:any-secret", {
        reason: "legacy-state",
        previousBotId: "111111",
        currentBotId: "111111",
        staleLastUpdateId: 999,
      });
    });
  });

  it("awaits rotation cleanup before returning", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeOffset(42, "111111:original");

      let cleaned = false;
      const offset = await readTelegramUpdateOffset({
        accountId: "default",
        botToken: "111111:rotated",
        onRotationDetected: async () => {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          cleaned = true;
        },
      });

      expect(offset).toBeNull();
      expect(cleaned).toBe(true);
    });
  });

  it("ignores invalid persisted update IDs from plugin-state", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await updateOffsetStore.register("default", state(-1, "111111"));
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();

      await updateOffsetStore.register("default", state("not-a-number", "111111"));
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
    });
  });

  it.each([1, 2])("requires Doctor before reading or preparing a v%s offset", async (version) => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      const original = {
        version,
        lastUpdateId: 777,
        ...(version === 2 ? { botId: "111111" } : {}),
      };
      await updateOffsetStore.register("default", original);
      await expect(readTelegramUpdateOffset({})).rejects.toThrow("openclaw doctor --fix");
      await expect(
        prepareTelegramAccount({
          accountId: "default",
          botToken: "222222:fixture",
          onRotationDetected() {},
        }),
      ).rejects.toThrow("openclaw doctor --fix");
      expect(await updateOffsetStore.lookup("default")).toEqual(original);
    });
  });

  it("rejects writing invalid update IDs", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await expect(writeOffset(-1)).rejects.toThrow(/non-negative safe integer/i);
    });
  });
});
