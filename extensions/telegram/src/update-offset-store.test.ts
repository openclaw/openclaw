import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
  TELEGRAM_UPDATE_OFFSET_NAMESPACE,
  type TelegramUpdateOffsetState,
  deleteTelegramUpdateOffset,
  readTelegramUpdateOffset,
  setTelegramUpdateOffsetStoreForTest,
  writeTelegramUpdateOffset,
} from "./update-offset-store.js";

describe("deleteTelegramUpdateOffset", () => {
  beforeEach(async () => {
    const store = createPluginStateKeyedStoreForTests<TelegramUpdateOffsetState>("telegram", {
      namespace: TELEGRAM_UPDATE_OFFSET_NAMESPACE,
      maxEntries: TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
    });
    await store.clear();
    setTelegramUpdateOffsetStoreForTest(store);
  });

  afterEach(() => {
    setTelegramUpdateOffsetStoreForTest(undefined);
    resetPluginStateStoreForTests();
  });

  it("removes the offset file so a new bot starts fresh", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeTelegramUpdateOffset({ accountId: "default", updateId: 432_000_000 });
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBe(432_000_000);

      await deleteTelegramUpdateOffset({ accountId: "default" });
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
    });
  });

  it("keeps a missing offset file absent after delete", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await deleteTelegramUpdateOffset({ accountId: "nonexistent" });
      expect(await readTelegramUpdateOffset({ accountId: "nonexistent" })).toBeNull();
    });
  });

  it("removes the legacy offset file even when plugin-state delete fails", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async ({ stateDir }) => {
      const legacyPath = path.join(stateDir, "telegram", "update-offset-default.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ version: 2, lastUpdateId: 333, botId: "111111" }, null, 2)}\n`,
        "utf-8",
      );
      setTelegramUpdateOffsetStoreForTest({
        ...createPluginStateKeyedStoreForTests<TelegramUpdateOffsetState>("telegram", {
          namespace: TELEGRAM_UPDATE_OFFSET_NAMESPACE,
          maxEntries: TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
        }),
        async delete() {
          throw new Error("store delete failed");
        },
      });

      await expect(deleteTelegramUpdateOffset({ accountId: "default" })).rejects.toThrow(
        "store delete failed",
      );
      await expect(fs.access(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
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

  it("falls back to an atomic legacy file when plugin-state writes fail", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      setTelegramUpdateOffsetStoreForTest({
        ...createPluginStateKeyedStoreForTests<TelegramUpdateOffsetState>("telegram", {
          namespace: TELEGRAM_UPDATE_OFFSET_NAMESPACE,
          maxEntries: TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
        }),
        async register() {
          throw new Error("store write failed");
        },
      });

      await writeTelegramUpdateOffset({ accountId: "default", updateId: 808 });

      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBe(808);
    });
  });

  it("prefers a newer legacy fallback offset over stale plugin-state", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      const store = createPluginStateKeyedStoreForTests<TelegramUpdateOffsetState>("telegram", {
        namespace: TELEGRAM_UPDATE_OFFSET_NAMESPACE,
        maxEntries: TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
      });
      setTelegramUpdateOffsetStoreForTest(store);
      await writeTelegramUpdateOffset({ accountId: "default", updateId: 10 });
      setTelegramUpdateOffsetStoreForTest({
        ...store,
        async register() {
          throw new Error("store write failed");
        },
      });

      await writeTelegramUpdateOffset({ accountId: "default", updateId: 20 });

      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBe(20);
    });
  });

  it("prefers token-compatible plugin-state over a higher stale legacy offset", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async ({ stateDir }) => {
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 10,
        botToken: "111111:current",
      });
      const legacyPath = path.join(stateDir, "telegram", "update-offset-default.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify(
          {
            version: 3,
            lastUpdateId: 999,
            botId: "222222",
            tokenFingerprint: "stale",
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      expect(
        await readTelegramUpdateOffset({
          accountId: "default",
          botToken: "111111:current",
        }),
      ).toBe(10);
    });
  });

  it("removes legacy fallback files after successful plugin-state writes", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async ({ stateDir }) => {
      const legacyPath = path.join(stateDir, "telegram", "update-offset-default.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ version: 2, lastUpdateId: 10, botId: "111111" }, null, 2)}\n`,
        "utf-8",
      );

      await writeTelegramUpdateOffset({ accountId: "default", updateId: 11 });

      await expect(fs.access(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("returns null when stored offset was written by a different bot token", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 321,
        botToken: "111111:token-a",
      });

      expect(
        await readTelegramUpdateOffset({
          accountId: "default",
          botToken: "222222:token-b",
        }),
      ).toBeNull();
      expect(
        await readTelegramUpdateOffset({
          accountId: "default",
          botToken: "111111:token-a",
        }),
      ).toBe(321);
    });
  });

  it("invokes onRotationDetected when the stored bot id no longer matches", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 1500,
        botToken: "111111:token-a",
      });

      const rotations: Array<Record<string, unknown>> = [];
      const offset = await readTelegramUpdateOffset({
        accountId: "default",
        botToken: "222222:token-b",
        onRotationDetected: (info) => {
          rotations.push({ ...info });
        },
      });

      expect(offset).toBeNull();
      expect(rotations).toEqual([
        {
          reason: "bot-id-changed",
          previousBotId: "111111",
          currentBotId: "222222",
          staleLastUpdateId: 1500,
        },
      ]);
    });
  });

  it("invokes onRotationDetected for legacy offsets without bot identity", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async ({ stateDir }) => {
      const legacyPath = path.join(stateDir, "telegram", "update-offset-default.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ version: 1, lastUpdateId: 777 }, null, 2)}\n`,
        "utf-8",
      );

      const rotations: Array<Record<string, unknown>> = [];
      const offset = await readTelegramUpdateOffset({
        accountId: "default",
        botToken: "333333:token-c",
        onRotationDetected: (info) => {
          rotations.push({ ...info });
        },
      });

      expect(offset).toBeNull();
      expect(rotations).toEqual([
        {
          reason: "legacy-state",
          previousBotId: null,
          currentBotId: "333333",
          staleLastUpdateId: 777,
        },
      ]);
    });
  });

  it("reads legacy offset files when the plugin runtime is unavailable", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async ({ stateDir }) => {
      const legacyPath = path.join(stateDir, "telegram", "update-offset-primary.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ version: 2, lastUpdateId: 4242, botId: "111111" }, null, 2)}\n`,
        "utf-8",
      );

      setTelegramUpdateOffsetStoreForTest(undefined);

      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBe(4242);
    });
  });

  it("falls back to legacy offset files when the plugin-state read fails", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async ({ stateDir }) => {
      const legacyPath = path.join(stateDir, "telegram", "update-offset-primary.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ version: 2, lastUpdateId: 5555, botId: "111111" }, null, 2)}\n`,
        "utf-8",
      );

      setTelegramUpdateOffsetStoreForTest({
        ...createPluginStateKeyedStoreForTests<TelegramUpdateOffsetState>("telegram", {
          namespace: TELEGRAM_UPDATE_OFFSET_NAMESPACE,
          maxEntries: TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
        }),
        async lookup() {
          throw new Error("store unavailable");
        },
      });

      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBe(5555);
    });
  });

  it("detects same-bot token rotation via the persisted fingerprint", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      const original = "111111:original-secret";
      const rotated = "111111:rotated-secret";

      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 42,
        botToken: original,
      });

      expect(
        await readTelegramUpdateOffset({
          accountId: "default",
          botToken: original,
        }),
      ).toBe(42);

      const rotations: Array<Record<string, unknown>> = [];
      const offset = await readTelegramUpdateOffset({
        accountId: "default",
        botToken: rotated,
        onRotationDetected: (info) => {
          rotations.push({ ...info });
        },
      });

      expect(offset).toBeNull();
      expect(rotations).toEqual([
        {
          reason: "token-rotated",
          previousBotId: "111111",
          currentBotId: "111111",
          staleLastUpdateId: 42,
        },
      ]);
    });
  });

  it("treats v2 bot-id-only offsets as stale when token identity cannot be verified", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async ({ stateDir }) => {
      const legacyPath = path.join(stateDir, "telegram", "update-offset-default.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ version: 2, lastUpdateId: 999, botId: "111111" }, null, 2)}\n`,
        "utf-8",
      );

      const rotations: Array<Record<string, unknown>> = [];
      const offset = await readTelegramUpdateOffset({
        accountId: "default",
        botToken: "111111:any-secret",
        onRotationDetected: (info) => {
          rotations.push({ ...info });
        },
      });

      expect(offset).toBeNull();
      expect(rotations).toEqual([
        {
          reason: "legacy-state",
          previousBotId: "111111",
          currentBotId: "111111",
          staleLastUpdateId: 999,
        },
      ]);
    });
  });

  it("awaits rotation cleanup before returning", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 42,
        botToken: "111111:original",
      });

      let cleaned = false;
      const offset = await readTelegramUpdateOffset({
        accountId: "default",
        botToken: "111111:rotated",
        onRotationDetected: async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          cleaned = true;
        },
      });

      expect(offset).toBeNull();
      expect(cleaned).toBe(true);
    });
  });

  it("treats legacy offset records without bot identity as stale when token is provided", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async ({ stateDir }) => {
      const legacyPath = path.join(stateDir, "telegram", "update-offset-default.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ version: 1, lastUpdateId: 777 }, null, 2)}\n`,
        "utf-8",
      );

      expect(
        await readTelegramUpdateOffset({
          accountId: "default",
          botToken: "333333:token-c",
        }),
      ).toBeNull();
    });
  });

  it("ignores invalid persisted update IDs from disk", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async ({ stateDir }) => {
      const offsetPath = path.join(stateDir, "telegram", "update-offset-default.json");
      await fs.mkdir(path.dirname(offsetPath), { recursive: true });
      await fs.writeFile(
        offsetPath,
        `${JSON.stringify({ version: 2, lastUpdateId: -1, botId: "111111" }, null, 2)}\n`,
        "utf-8",
      );
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();

      await fs.writeFile(
        offsetPath,
        `${JSON.stringify({ version: 2, lastUpdateId: Number.POSITIVE_INFINITY, botId: "111111" }, null, 2)}\n`,
        "utf-8",
      );
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
    });
  });

  it("rejects writing invalid update IDs", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await expect(
        writeTelegramUpdateOffset({ accountId: "default", updateId: -1 as number }),
      ).rejects.toThrow(/non-negative safe integer/i);
    });
  });
});
