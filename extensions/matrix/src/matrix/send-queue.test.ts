import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueSend } from "./send-queue.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("enqueueSend", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes sends per room", async () => {
    const gate = deferred<void>();
    const events: string[] = [];

    const first = enqueueSend("!room:example.org", async () => {
      events.push("start1");
      await gate.promise;
      events.push("end1");
      return "one";
    });
    const second = enqueueSend("!room:example.org", async () => {
      events.push("start2");
      events.push("end2");
      return "two";
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(events).toEqual(["start1"]);

    await vi.advanceTimersByTimeAsync(300);
    expect(events).toEqual(["start1"]);

    gate.resolve();
    await first;
    await vi.advanceTimersByTimeAsync(149);
    expect(events).toEqual(["start1", "end1"]);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(events).toEqual(["start1", "end1", "start2", "end2"]);
  });

  it("does not serialize across different rooms", async () => {
    const events: string[] = [];

    const a = enqueueSend("!a:example.org", async () => {
      events.push("a");
      return "a";
    });
    const b = enqueueSend("!b:example.org", async () => {
      events.push("b");
      return "b";
    });

    await vi.advanceTimersByTimeAsync(150);
    await Promise.all([a, b]);
    expect(events.sort()).toEqual(["a", "b"]);
  });

  it("continues queue after failures", async () => {
    const first = enqueueSend("!room:example.org", async () => {
      throw new Error("boom");
    }).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    );

    await vi.advanceTimersByTimeAsync(150);
    const firstResult = await first;
    expect(firstResult.ok).toBe(false);
    expect(firstResult.error).toBeInstanceOf(Error);
    expect((firstResult.error as Error).message).toBe("boom");

    const second = enqueueSend("!room:example.org", async () => "ok");
    await vi.advanceTimersByTimeAsync(150);
    await expect(second).resolves.toBe("ok");
  });

  it("continues queued work when the head task fails", async () => {
    const gate = deferred<void>();
    const events: string[] = [];

    const first = enqueueSend("!room:example.org", async () => {
      events.push("start1");
      await gate.promise;
      throw new Error("boom");
    }).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    );
    const second = enqueueSend("!room:example.org", async () => {
      events.push("start2");
      return "two";
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(events).toEqual(["start1"]);

    gate.resolve();
    const firstResult = await first;
    expect(firstResult.ok).toBe(false);
    expect(firstResult.error).toBeInstanceOf(Error);

    await vi.advanceTimersByTimeAsync(150);
    await expect(second).resolves.toBe("two");
    expect(events).toEqual(["start1", "start2"]);
  });
});
