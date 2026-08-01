import { describe, expect, it } from "vitest";
import { EventHub } from "./event-hub.js";

describe("EventHub subscriber ownership", () => {
  it("isolates a failing subscriber filter from healthy event streams", async () => {
    const hub = new EventHub<string>();
    const failedStream = hub.stream(() => {
      throw new Error("subscriber filter failed");
    });
    const failed = failedStream[Symbol.asyncIterator]();
    const healthy = hub.stream()[Symbol.asyncIterator]();
    const failedResult = failed.next();
    const healthyResult = healthy.next();

    expect(() => hub.publish("first")).not.toThrow();

    await expect(failedResult).rejects.toThrow("subscriber filter failed");
    await expect(healthyResult).resolves.toEqual({ done: false, value: "first" });

    const nextHealthyResult = healthy.next();
    hub.publish("second");
    await expect(nextHealthyResult).resolves.toEqual({ done: false, value: "second" });

    await failed.return?.();
    await healthy.return?.();
  });

  it("settles simultaneous next calls in event order", async () => {
    const hub = new EventHub<string>();
    const iterator = hub.stream()[Symbol.asyncIterator]();
    const first = iterator.next();
    const second = iterator.next();

    hub.publish("first");
    hub.publish("second");

    await expect(Promise.all([first, second])).resolves.toEqual([
      { done: false, value: "first" },
      { done: false, value: "second" },
    ]);
    await iterator.return?.();
  });

  it("reserves a published event for its awakened waiter before later next calls", async () => {
    const hub = new EventHub<string>();
    const iterator = hub.stream()[Symbol.asyncIterator]();
    const first = iterator.next();

    hub.publish("first");
    const second = iterator.next();
    hub.publish("second");

    await expect(Promise.all([first, second])).resolves.toEqual([
      { done: false, value: "first" },
      { done: false, value: "second" },
    ]);
    await iterator.return?.();
  });

  it("releases every pending next call when an iterator is returned", async () => {
    const hub = new EventHub<string>();
    const iterator = hub.stream()[Symbol.asyncIterator]();
    const first = iterator.next();
    const second = iterator.next();

    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { done: true, value: undefined },
      { done: true, value: undefined },
    ]);
  });
});
