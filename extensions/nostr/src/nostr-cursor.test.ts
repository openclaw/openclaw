import type { Event } from "nostr-tools";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNostrCursorStateWriter, createNostrDurableCursor } from "./nostr-cursor.js";

function event(createdAt: number): Event {
  return { created_at: createdAt } as Event;
}

function createWriter(write: (cursor: number) => Promise<void>) {
  return createNostrCursorStateWriter({
    initialCursor: 1_000,
    minimumCursor: 1_000,
    debounceMs: 60_000,
    write,
  });
}

describe("Nostr durable cursor", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["caps progress inside replay overlap", 900, 1_020],
    ["ignores rejections older than the relay filter", 700, 1_100],
  ] as const)("%s", (_name, rejectedAt, expected) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_200_000);
    const cursor = createNostrDurableCursor({ since: 800, replayOverlapSec: 120 });
    cursor.recordDurableAppend(event(1_100));
    cursor.recordTransientRejection(event(rejectedAt));
    expect(cursor.markBackfillComplete()).toBe(expected);
    if (rejectedAt === 900) {
      expect(cursor.recordTransientRejection(event(950))).toBeUndefined();
    }
  });

  it.each(["pending", "in-flight"])(
    "serializes a safety rewind after an older %s progress write",
    async (progressState) => {
      const highStarted = createDeferred<void>();
      const highGate = createDeferred<void>();
      const write = vi.fn(async (cursor: number) => {
        if (cursor === 2_000) {
          highStarted.resolve();
          await highGate.promise;
        }
      });
      const writer = createWriter(write);
      writer.schedule(2_000);
      const highWrite = writer.flush();
      if (progressState === "in-flight") {
        await withTimeout(highStarted.promise, 1_000, {
          message: "Nostr progress write did not start",
        });
      }
      const rewind = writer.persistNow(1_050);
      const stricterRewind = writer.persistNow(1_020);
      await withTimeout(highStarted.promise, 1_000, {
        message: "Nostr progress write did not start",
      });
      expect(write).toHaveBeenCalledWith(2_000);
      highGate.resolve();
      await Promise.all([highWrite, rewind, stricterRewind]);

      expect(write.mock.calls.map(([cursor]) => cursor)).toEqual([2_000, 1_020]);
    },
  );

  it("persists a cursor queued while an idle flush is settling", async () => {
    const write = vi.fn<(cursor: number) => Promise<void>>().mockResolvedValue(undefined);
    const writer = createWriter(write);
    const idle = writer.flush();
    const persist = writer.persistNow(1_020);
    await Promise.all([idle, persist]);

    expect(write.mock.calls.map(([cursor]) => cursor)).toEqual([1_020]);
  });

  it("keeps retrying a failed safety write until it is durable", async () => {
    vi.useFakeTimers();
    const write = vi
      .fn<(cursor: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("state unavailable"))
      .mockRejectedValueOnce(new Error("state unavailable"))
      .mockRejectedValueOnce(new Error("state unavailable"))
      .mockResolvedValue(undefined);
    const writer = createWriter(write);
    writer.schedule(1_020);
    const recovered = expect(writer.flushUntilSuccess()).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    await recovered;
    expect(write).toHaveBeenCalledTimes(4);
    expect(write).toHaveBeenLastCalledWith(1_020);
  });
});
