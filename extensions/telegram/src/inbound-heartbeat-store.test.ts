import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../../../src/test-helpers/state-dir-env.js";
import {
  readTelegramInboundHeartbeat,
  resolveTelegramInboundHeartbeatPath,
  writeTelegramInboundHeartbeat,
} from "./inbound-heartbeat-store.js";

describe("telegramInboundHeartbeatStore", () => {
  it("writes and reads back an empty_ack heartbeat round-trip", async () => {
    await withStateDirEnv("openclaw-tg-inbound-", async () => {
      const fixedTs = 1_765_432_000_000;
      await writeTelegramInboundHeartbeat({
        accountId: "default",
        botToken: "8246637923:dummy-token",
        outcome: "empty_ack",
        updateCount: 0,
        now: () => fixedTs,
      });

      const hb = await readTelegramInboundHeartbeat({ accountId: "default" });
      expect(hb).not.toBeNull();
      expect(hb).toMatchObject({
        version: 1,
        accountId: "default",
        botId: "8246637923",
        ts: fixedTs,
        outcome: "empty_ack",
        updateCount: 0,
        lastUpdateId: null,
        source: "getUpdates",
      });
      expect(hb?.isoTs).toBe(new Date(fixedTs).toISOString());
    });
  });

  it("records the max update_id for a real message batch", async () => {
    await withStateDirEnv("openclaw-tg-inbound-", async () => {
      await writeTelegramInboundHeartbeat({
        accountId: "default",
        outcome: "message",
        updateCount: 3,
        lastUpdateId: 518_493_250,
      });

      const hb = await readTelegramInboundHeartbeat({ accountId: "default" });
      expect(hb?.outcome).toBe("message");
      expect(hb?.updateCount).toBe(3);
      expect(hb?.lastUpdateId).toBe(518_493_250);
    });
  });

  it("writes per-account so multi-account polling stays isolated", async () => {
    await withStateDirEnv("openclaw-tg-inbound-", async () => {
      await writeTelegramInboundHeartbeat({
        accountId: "default",
        outcome: "empty_ack",
        updateCount: 0,
        now: () => 1000,
      });
      await writeTelegramInboundHeartbeat({
        accountId: "alerts",
        outcome: "message",
        updateCount: 1,
        lastUpdateId: 42,
        now: () => 2000,
      });

      const hbDefault = await readTelegramInboundHeartbeat({ accountId: "default" });
      const hbAlerts = await readTelegramInboundHeartbeat({ accountId: "alerts" });
      expect(hbDefault?.outcome).toBe("empty_ack");
      expect(hbDefault?.ts).toBe(1000);
      expect(hbAlerts?.outcome).toBe("message");
      expect(hbAlerts?.ts).toBe(2000);
      expect(hbAlerts?.lastUpdateId).toBe(42);
    });
  });

  it("lands the file under ~/.openclaw/telegram/last-inbound-*.json in the state dir", async () => {
    await withStateDirEnv("openclaw-tg-inbound-", async ({ stateDir }) => {
      await writeTelegramInboundHeartbeat({
        accountId: "default",
        outcome: "empty_ack",
        updateCount: 0,
      });
      const expected = path.join(stateDir, "telegram", "last-inbound-default.json");
      expect(resolveTelegramInboundHeartbeatPath("default")).toBe(expected);
      // File must exist on disk after a successful write.
      await expect(fs.stat(expected)).resolves.toBeTruthy();
    });
  });

  it("returns null when the heartbeat file is absent", async () => {
    await withStateDirEnv("openclaw-tg-inbound-", async () => {
      expect(await readTelegramInboundHeartbeat({ accountId: "default" })).toBeNull();
    });
  });

  it("ignores heartbeat records with unknown or malformed shape", async () => {
    await withStateDirEnv("openclaw-tg-inbound-", async ({ stateDir }) => {
      const filePath = path.join(stateDir, "telegram", "last-inbound-default.json");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "not-json", "utf-8");
      expect(await readTelegramInboundHeartbeat({ accountId: "default" })).toBeNull();

      await fs.writeFile(
        filePath,
        JSON.stringify({ version: 999, outcome: "empty_ack", ts: 1, updateCount: 0 }),
        "utf-8",
      );
      expect(await readTelegramInboundHeartbeat({ accountId: "default" })).toBeNull();

      await fs.writeFile(
        filePath,
        JSON.stringify({ version: 1, outcome: "nope", ts: 1, updateCount: 0 }),
        "utf-8",
      );
      expect(await readTelegramInboundHeartbeat({ accountId: "default" })).toBeNull();
    });
  });

  it("rejects a negative or non-finite updateCount", async () => {
    await withStateDirEnv("openclaw-tg-inbound-", async () => {
      await expect(
        writeTelegramInboundHeartbeat({
          accountId: "default",
          outcome: "message",
          updateCount: -1 as number,
        }),
      ).rejects.toThrow(/non-negative/i);
      await expect(
        writeTelegramInboundHeartbeat({
          accountId: "default",
          outcome: "message",
          updateCount: Number.POSITIVE_INFINITY,
        }),
      ).rejects.toThrow(/non-negative/i);
    });
  });

  it("normalizes odd account identifiers into a safe file segment", async () => {
    await withStateDirEnv("openclaw-tg-inbound-", async ({ stateDir }) => {
      await writeTelegramInboundHeartbeat({
        accountId: "  weird/account name  ",
        outcome: "empty_ack",
        updateCount: 0,
      });
      const expected = path.join(stateDir, "telegram", "last-inbound-weird_account_name.json");
      await expect(fs.stat(expected)).resolves.toBeTruthy();
    });
  });
});
