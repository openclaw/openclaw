import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteTelegramUpdateOffset,
  readTelegramUpdateOffset,
  resetTelegramUpdateOffsetsForTests,
  writeTelegramUpdateOffset,
} from "./update-offset-store.js";

afterEach(async () => {
  await resetTelegramUpdateOffsetsForTests();
  resetPluginStateStoreForTests();
});

describe("deleteTelegramUpdateOffset", () => {
  it("removes the offset row so a new bot starts fresh", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeTelegramUpdateOffset({ accountId: "default", updateId: 432_000_000 });
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBe(432_000_000);

      await deleteTelegramUpdateOffset({ accountId: "default" });
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
    });
  });

  it("does not throw when the offset row does not exist", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await deleteTelegramUpdateOffset({ accountId: "nonexistent" });
      expect(await readTelegramUpdateOffset({ accountId: "nonexistent" })).toBeNull();
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

  it("rejects writing invalid update IDs", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await expect(
        writeTelegramUpdateOffset({ accountId: "default", updateId: -1 as number }),
      ).rejects.toThrow(/non-negative safe integer/i);
    });
  });
});
