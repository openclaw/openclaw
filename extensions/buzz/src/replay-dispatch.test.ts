import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  BUZZ_REPLAY_DISPATCH_MAX_PENDING,
  createBuzzReplayDispatchQueue,
} from "./replay-dispatch.js";

const CAPACITY = BUZZ_REPLAY_DISPATCH_MAX_PENDING + 8;

function createBlockedQueue(full = false) {
  const releases: Array<() => void> = [];
  const queue = createBuzzReplayDispatchQueue({ onTaskError: () => {} });
  const blockTask = () => {
    const gate = createDeferred();
    releases.push(() => gate.resolve());
    return () => gate.promise.then(() => {});
  };
  if (full) {
    for (let index = 0; index < CAPACITY; index += 1) {
      expect(queue.enqueue(blockTask())).toBe("accepted");
    }
  }
  return { queue, releases, blockTask };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe("Buzz replay dispatch capacity reservations", () => {
  it("withholds reserved slots from later live events", async () => {
    const { queue, releases, blockTask } = createBlockedQueue(true);
    const pageSize = 100;

    const reservationPromise = queue.reserveCapacity(pageSize);
    const granted = vi.fn();
    void reservationPromise.then(granted);
    await flush();
    expect(granted).not.toHaveBeenCalled();
    expect(queue.enqueue(blockTask())).toBe("overflow");
    releases.slice(0, pageSize).forEach((release) => release());
    const reservation = await reservationPromise;
    expect(reservation).toBeDefined();

    for (let index = 0; index < pageSize; index += 1) {
      expect(queue.enqueue(blockTask())).toBe("overflow");
    }
    const admissions = new Set<string>();
    for (let index = 0; index < pageSize; index += 1) {
      admissions.add(reservation?.enqueue(blockTask()) ?? "missing");
    }

    expect([...admissions]).toEqual(["accepted"]);
    expect(reservation?.enqueue(blockTask())).toBe("overflow");
  });

  it("returns unused slots when a reservation is released", async () => {
    const { queue, releases } = createBlockedQueue(true);

    const firstPromise = queue.reserveCapacity(50);
    releases.slice(0, 50).forEach((release) => release());
    const first = await firstPromise;
    expect(first).toBeDefined();

    const second = vi.fn();
    void queue.reserveCapacity(50).then(second);
    await flush();
    expect(second).not.toHaveBeenCalled();

    first?.release();
    await flush();
    expect(second).toHaveBeenCalledExactlyOnceWith(expect.anything());
  });

  it("abandons waiting reservations once the queue closes", async () => {
    const { queue } = createBlockedQueue(true);
    const reservationPromise = queue.reserveCapacity(10);

    void queue.close();

    expect(await reservationPromise).toBeUndefined();
    expect(await queue.reserveCapacity(1)).toBeUndefined();
  });

  it("rejects work from a held reservation after the queue closes", async () => {
    const { queue, blockTask } = createBlockedQueue();
    const reservation = await queue.reserveCapacity(2);

    await queue.close();

    expect(reservation?.enqueue(blockTask())).toBe("closed");
    reservation?.release();
    expect(await queue.reserveCapacity(1)).toBeUndefined();
  });
});
