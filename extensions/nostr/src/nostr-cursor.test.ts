import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNostrCursorStateWriter } from "./nostr-cursor.js";

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

  it.each([false, true])("orders rewinds (in-flight=%s)", async (inFlight) => {
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
    if (inFlight) {
      await withTimeout(highStarted.promise, 1_000);
    }
    const rewind = writer.persistNow(1_050);
    const stricterRewind = writer.persistNow(1_020);
    await withTimeout(highStarted.promise, 1_000);
    highGate.resolve();
    await Promise.all([highWrite, rewind, stricterRewind]);
    expect(write.mock.calls.map(([cursor]) => cursor)).toEqual([2_000, 1_020]);
  });

  it("persists a cursor queued while an idle flush is settling", async () => {
    const write = vi.fn<(cursor: number) => Promise<void>>().mockResolvedValue(undefined);
    const writer = createWriter(write);
    const idle = writer.flush();
    const persist = writer.persistNow(1_020);
    await Promise.all([idle, persist]);
    expect(write.mock.calls.map(([cursor]) => cursor)).toEqual([1_020]);
  });

  it.for([false, true])(
    "retries safety writes unless admission is closed (%s)",
    async (terminal) => {
      vi.useFakeTimers();
      const error = new Error("state unavailable", {
        cause: { code: terminal ? "STATE_DATABASE_READ_ADMISSION_INVALIDATED" : "temporary" },
      });
      let failures = 3;
      const write = vi.fn(async () => {
        if (failures-- > 0) {
          throw error;
        }
      });
      const writer = createWriter(write);
      writer.schedule(1_020);
      const recovered = writer.flushUntilSuccess().then(
        () => true,
        () => false,
      );
      await vi.runAllTimersAsync();
      expect(await recovered).toBe(!terminal);
      expect(write).toHaveBeenCalledTimes(terminal ? 1 : 4);
      expect(write).toHaveBeenLastCalledWith(1_020);
    },
  );
});
