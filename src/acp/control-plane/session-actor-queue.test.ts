import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must mock the logger module before importing the queue so the warn call is
// observable. `vi.mock` is hoisted above top-level statements, so we need
// `vi.hoisted` to ensure `warnSpy` is defined by the time the factory runs.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: warnSpy,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionActorQueue } from "./session-actor-queue.js";

function defer<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("SessionActorQueue backlog warning", () => {
  beforeEach(() => {
    warnSpy.mockReset();
    delete process.env.OPENCLAW_ACP_QUEUE_WARN_THRESHOLD;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_ACP_QUEUE_WARN_THRESHOLD;
  });

  it("emits a warn when pending count reaches threshold (default=3)", async () => {
    const queue = new SessionActorQueue();
    const gate1 = defer();
    const gate2 = defer();
    const gate3 = defer();

    // First op holds the queue; remaining two queue up behind it.
    const r1 = queue.run("acct-a", async () => {
      await gate1.promise;
    });
    const r2 = queue.run("acct-a", async () => {
      await gate2.promise;
    });
    const r3 = queue.run("acct-a", async () => {
      await gate3.promise;
    });

    // At this point pendingCount for "acct-a" should have crossed 3 on the
    // third enqueue and fired the warn exactly once.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "acp session actor queue backlog",
      expect.objectContaining({
        sessionKey: "acct-a",
        pendingCount: 3,
        threshold: 3,
      }),
    );

    // Drain so the test cleans up.
    gate1.resolve();
    gate2.resolve();
    gate3.resolve();
    await Promise.all([r1, r2, r3]);
  });

  it("does not double-fire on the same rising edge (rate-limited per key)", async () => {
    const queue = new SessionActorQueue();
    const gates = [defer(), defer(), defer(), defer(), defer()];

    const runs = gates.map((g) =>
      queue.run("acct-b", async () => {
        await g.promise;
      }),
    );

    // After 5 enqueues, we should still only have one warn (single rising
    // edge, and we're inside the rate-limit window).
    expect(warnSpy).toHaveBeenCalledTimes(1);

    for (const g of gates) {
      g.resolve();
    }
    await Promise.all(runs);
  });

  it("re-arms the warn after the backlog drains back below threshold", async () => {
    const queue = new SessionActorQueue();
    const batch1 = [defer(), defer(), defer()];

    const runs1 = batch1.map((g) =>
      queue.run("acct-c", async () => {
        await g.promise;
      }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Drain fully.
    for (const g of batch1) {
      g.resolve();
    }
    await Promise.all(runs1);

    // New backlog after drain should fire a fresh warn (rising edge).
    const batch2 = [defer(), defer(), defer()];
    const runs2 = batch2.map((g) =>
      queue.run("acct-c", async () => {
        await g.promise;
      }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);

    for (const g of batch2) {
      g.resolve();
    }
    await Promise.all(runs2);
  });

  it("honors OPENCLAW_ACP_QUEUE_WARN_THRESHOLD", async () => {
    process.env.OPENCLAW_ACP_QUEUE_WARN_THRESHOLD = "5";
    const queue = new SessionActorQueue();
    const gates = [defer(), defer(), defer(), defer()];

    const runs = gates.map((g) =>
      queue.run("acct-d", async () => {
        await g.promise;
      }),
    );

    // 4 pending — below the 5 threshold. No warn.
    expect(warnSpy).not.toHaveBeenCalled();

    for (const g of gates) {
      g.resolve();
    }
    await Promise.all(runs);
  });
});
