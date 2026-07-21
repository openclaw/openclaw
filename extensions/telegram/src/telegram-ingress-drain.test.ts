// Telegram ingress drain adapter: dispatch result propagation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { createTelegramIngressMonitor } from "./telegram-ingress-drain.js";
import { telegramSpooledUpdateLaneKey } from "./telegram-ingress-spool.js";
import type { TelegramSpooledUpdatePayload } from "./telegram-ingress-spool.payload.js";

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-ingress-drain-"));
  try {
    return await fn(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

const cfg = {
  channels: {
    telegram: {
      allowFrom: ["111"],
      dmPolicy: "allowlist",
    },
  },
} as OpenClawConfig;

function updatePayload(updateId: number): TelegramSpooledUpdatePayload {
  return {
    version: 1,
    updateId,
    receivedAt: updateId,
    update: {
      update_id: updateId,
      message: {
        text: "hello",
        from: { id: 111 },
        chat: { id: 111, type: "private" },
      },
    },
  };
}

describe("createTelegramIngressMonitor", () => {
  it("replays queue backpressure after restart without spending retry budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
          channelId: "telegram",
          accountId: "default",
          stateDir,
        });
        const eventId = "3".padStart(16, "0");
        const payload = updatePayload(3);
        const laneKey = telegramSpooledUpdateLaneKey(payload.update);
        await queue.enqueue(eventId, payload, { laneKey });
        const backpressure = Object.assign(new Error("followup queue capacity exhausted"), {
          [Symbol.for("openclaw.ingressRetryWithoutPenalty")]: true,
        });

        const firstMonitor = createTelegramIngressMonitor({
          queue,
          cfg,
          accountId: "default",
          pollIntervalMs: 60_000,
          dispatch: async () => ({ kind: "failed-retryable", error: backpressure }),
        });
        firstMonitor.start();
        await firstMonitor.waitForIdle();
        const pending = await queue.listPending({ limit: "all" });
        expect(pending).toMatchObject([
          { id: eventId, attempts: 0, lastAttemptAt: 1_000, payload, laneKey },
        ]);
        expect(pending[0]).not.toHaveProperty("metadata");
        await firstMonitor.stop();

        const dispatch = vi.fn(async (_update: unknown, lifecycle) => {
          await lifecycle.onAdopted();
          return { kind: "completed" as const };
        });
        const restartedMonitor = createTelegramIngressMonitor({
          queue,
          cfg,
          accountId: "default",
          pollIntervalMs: 60_000,
          dispatch,
        });
        restartedMonitor.start();
        await restartedMonitor.waitForIdle();
        expect(dispatch).not.toHaveBeenCalled();

        vi.setSystemTime(2_000);
        restartedMonitor.requestDrain();
        await restartedMonitor.waitForIdle();
        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch).toHaveBeenCalledWith(payload.update, expect.anything());
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        await restartedMonitor.stop();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates failed-retryable dispatch results as claim release (not tombstone)", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "1".padStart(16, "0");
      const payload = updatePayload(1);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });

      const retryError = new Error("provider blip");
      const monitor = createTelegramIngressMonitor({
        queue,
        cfg,
        accountId: "default",
        dispatch: async () => ({ kind: "failed-retryable", error: retryError }),
      });

      monitor.start();
      await monitor.waitForIdle();

      // Failed-retryable must release, not complete — re-enqueue is pending, not tombstone.
      const status = await queue.enqueue(eventId, payload, { laneKey });
      expect(status.kind).not.toBe("completed");
      expect(status.kind === "accepted" || status.kind === "pending").toBe(true);

      const pending = await queue.listPending({ limit: "all" });
      expect(pending.some((row) => row.id === eventId)).toBe(true);

      await monitor.stop();
    });
  });

  it("tombstones completed dispatch results", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "2".padStart(16, "0");
      const payload = updatePayload(2);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });

      const monitor = createTelegramIngressMonitor({
        queue,
        cfg,
        accountId: "default",
        dispatch: async (_update, lifecycle) => {
          await lifecycle.onAdopted();
          return { kind: "completed" };
        },
      });

      monitor.start();
      await monitor.waitForIdle();

      const status = await queue.enqueue(eventId, payload, { laneKey });
      expect(status.kind).toBe("completed");
      await monitor.stop();
    });
  });
});
