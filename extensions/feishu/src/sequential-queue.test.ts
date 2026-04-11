import { describe, expect, it } from "vitest";
import { createSequentialQueue } from "./sequential-queue.js";

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createSequentialQueue", () => {
  it("serializes tasks for the same key", async () => {
    const enqueue = createSequentialQueue();
    const gate = createDeferred();
    const order: string[] = [];

    const first = enqueue("feishu:default:chat-1", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = enqueue("feishu:default:chat-1", async () => {
      order.push("second:start");
      order.push("second:end");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    gate.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("allows different keys to run concurrently", async () => {
    const enqueue = createSequentialQueue();
    const gateA = createDeferred();
    const gateB = createDeferred();
    const order: string[] = [];

    const first = enqueue("feishu:default:chat-1", async () => {
      order.push("chat-1:start");
      await gateA.promise;
      order.push("chat-1:end");
    });
    const second = enqueue("feishu:default:chat-1:btw:om_2", async () => {
      order.push("btw:start");
      await gateB.promise;
      order.push("btw:end");
    });

    await Promise.resolve();
    expect(order).toEqual(["chat-1:start", "btw:start"]);

    gateA.resolve();
    gateB.resolve();
    await Promise.all([first, second]);

    expect(order).toContain("chat-1:end");
    expect(order).toContain("btw:end");
  });
});
