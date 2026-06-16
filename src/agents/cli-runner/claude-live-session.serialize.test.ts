/** Tests the per-key turn serialization that prevents same-session live-turn restart races. */
import { describe, expect, it } from "vitest";
import { runExclusiveByKey } from "./claude-live-session.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runExclusiveByKey", () => {
  it("serializes same-key runs in arrival order (no overlap)", async () => {
    const chains = new Map<string, Promise<void>>();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const run = (id: string, holdMs: number) =>
      runExclusiveByKey(chains, "k", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(id);
        await new Promise((r) => setTimeout(r, holdMs));
        active -= 1;
      });

    // First holds the lock longest; if turns overlapped, b/c would start before a finishes.
    await Promise.all([run("a", 25), run("b", 5), run("c", 5)]);

    expect(maxActive).toBe(1);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("runs different keys concurrently", async () => {
    const chains = new Map<string, Promise<void>>();
    const events: string[] = [];
    const gate = deferred();

    const a = runExclusiveByKey(chains, "a", async () => {
      events.push("a:start");
      await gate.promise;
    });
    const b = runExclusiveByKey(chains, "b", async () => {
      events.push("b:start");
    });

    await b; // b should complete without waiting on a
    expect(events).toContain("b:start");
    gate.resolve();
    await a;
  });

  it("does not wedge the queue when a prior same-key run rejects", async () => {
    const chains = new Map<string, Promise<void>>();
    const failing = runExclusiveByKey(chains, "k", async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");

    const after = await runExclusiveByKey(chains, "k", async () => "ok");
    expect(after).toBe("ok");
  });

  it("releases the per-key entry once the tail settles", async () => {
    const chains = new Map<string, Promise<void>>();
    await runExclusiveByKey(chains, "k", async () => undefined);
    // Allow the finally + identity check to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(chains.has("k")).toBe(false);
  });

  it("propagates the run result and error to the caller", async () => {
    const chains = new Map<string, Promise<void>>();
    await expect(runExclusiveByKey(chains, "k", async () => 42)).resolves.toBe(42);
    await expect(
      runExclusiveByKey(chains, "k", async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
  });
});
