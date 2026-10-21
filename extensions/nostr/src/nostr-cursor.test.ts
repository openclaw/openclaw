import type { Event } from "nostr-tools";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNostrCursorStateWriter, createNostrDurableCursor } from "./nostr-cursor.js";

function event(createdAt: number): Event {
  return { created_at: createdAt } as Event;
}

describe("Nostr durable cursor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps progress so a transiently rejected event remains inside replay overlap", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_200_000);
    const cursor = createNostrDurableCursor({
      since: 800,
      replayOverlapSec: 120,
    });

    cursor.recordDurableAppend(event(1_100));
    cursor.recordTransientRejection(event(900));
    expect(cursor.markBackfillComplete()).toBe(1_020);
    expect(cursor.recordTransientRejection(event(950))).toBeUndefined();
  });

  it("ignores rejected events older than the active relay filter", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_200_000);
    const cursor = createNostrDurableCursor({
      since: 800,
      replayOverlapSec: 120,
    });

    cursor.recordDurableAppend(event(1_100));
    cursor.recordTransientRejection(event(700));
    expect(cursor.markBackfillComplete()).toBe(1_100);
  });

  it("serializes a safety rewind after an older in-flight progress write", async () => {
    const highStarted = createDeferred<void>();
    const highGate = createDeferred<void>();
    const write = vi.fn(async (cursor: number) => {
      if (cursor === 2_000) {
        highStarted.resolve();
        await highGate.promise;
      }
    });
    const writer = createNostrCursorStateWriter({
      initialCursor: 1_000,
      minimumCursor: 1_000,
      debounceMs: 60_000,
      write,
    });

    writer.schedule(2_000);
    const highWrite = writer.flush();
    await withTimeout(highStarted.promise, 1_000, {
      message: "Nostr progress write did not start",
    });
    expect(write).toHaveBeenCalledWith(2_000);
    const rewind = writer.persistNow(1_050);
    const stricterRewind = writer.persistNow(1_020);
    highGate.resolve();
    await Promise.all([highWrite, rewind, stricterRewind]);

    expect(write.mock.calls.map(([cursor]) => cursor)).toEqual([2_000, 1_020]);
  });

  it("keeps retrying a failed safety write until it is durable", async () => {
    vi.useFakeTimers();
    const write = vi
      .fn<(cursor: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("state unavailable"))
      .mockRejectedValueOnce(new Error("state unavailable"))
      .mockRejectedValueOnce(new Error("state unavailable"))
      .mockResolvedValue(undefined);
    const writer = createNostrCursorStateWriter({
      initialCursor: 1_000,
      minimumCursor: 1_000,
      debounceMs: 60_000,
      write,
    });

    writer.schedule(1_020);
    const recovered = expect(writer.flushUntilSuccess()).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    await recovered;
    expect(write).toHaveBeenCalledTimes(4);
    expect(write).toHaveBeenLastCalledWith(1_020);
  });
});
