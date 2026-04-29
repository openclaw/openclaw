import fs from "node:fs/promises";
import path from "node:path";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  deleteTelegramUpdateOffset,
  readTelegramUpdateOffset,
  readTelegramUpdateOffsetState,
  writeTelegramUpdateOffset,
} from "./update-offset-store.js";

describe("deleteTelegramUpdateOffset", () => {
  it("removes the offset file so a new bot starts fresh", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeTelegramUpdateOffset({ accountId: "default", updateId: 432_000_000 });
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBe(432_000_000);

      await deleteTelegramUpdateOffset({ accountId: "default" });
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
    });
  });

  it("does not throw when the offset file does not exist", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await expect(deleteTelegramUpdateOffset({ accountId: "nonexistent" })).resolves.not.toThrow();
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

  it("persists accepted and completed update offsets separately", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 102,
        completedUpdateId: 100,
        botToken: "111111:token-a",
      });

      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBe(102);
      expect(
        await readTelegramUpdateOffsetState({
          accountId: "default",
          botToken: "111111:token-a",
        }),
      ).toEqual({
        lastUpdateId: 102,
        completedUpdateId: 100,
      });
    });
  });

  it("preserves an empty completed watermark for fetched but unfinished updates", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 102,
        completedUpdateId: null,
      });

      expect(await readTelegramUpdateOffsetState({ accountId: "default" })).toEqual({
        lastUpdateId: 102,
        completedUpdateId: null,
      });
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

  it("rejects completed update IDs ahead of the accepted offset", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await expect(
        writeTelegramUpdateOffset({
          accountId: "default",
          updateId: 100,
          completedUpdateId: 101,
        }),
      ).rejects.toThrow(/cannot exceed accepted/i);
    });
  });
});
