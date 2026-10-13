import { describe, expect, it, vi } from "vitest";
import { createSlackSessionStatusCycle, createSlackThreadStatusGate } from "./thread-status.js";

describe("Slack thread status lifecycle", () => {
  it("ignores the predecessor's visible output until the successor shows its own", () => {
    const gate = createSlackThreadStatusGate();
    const live = { delivery: false, preview: false, draftId: undefined as string | undefined };
    gate.bind(() => live);

    expect(gate.hasVisibleOutput()).toBe(false);
    live.delivery = true;
    live.preview = true;
    live.draftId = "100.1";
    expect(gate.hasVisibleOutput()).toBe(true);

    gate.beginGeneration();
    expect(gate.hasVisibleOutput()).toBe(false);

    live.preview = false;
    live.preview = true;
    expect(gate.hasVisibleOutput()).toBe(false);
    live.draftId = "100.2";
    expect(gate.hasVisibleOutput()).toBe(true);
  });

  it("does not clear the thread when a parked inbound never published processing", async () => {
    const gate = createSlackThreadStatusGate();
    const publish = vi.fn(async () => true);
    const cycle = createSlackSessionStatusCycle({
      gate,
      publish,
      onActiveRestoreFailed: vi.fn(),
    });

    await cycle.stop();

    expect(publish).not.toHaveBeenCalled();
  });

  it("shows processing for a successor turn and restores active when that turn ends", async () => {
    const gate = createSlackThreadStatusGate();
    const live = { delivery: true, preview: true, draftId: "100.1" as string | undefined };
    gate.bind(() => live);
    const publish = vi.fn(async () => true);
    const cycle = createSlackSessionStatusCycle({
      gate,
      publish,
      onActiveRestoreFailed: vi.fn(),
    });

    await cycle.start("First");
    expect(publish).not.toHaveBeenCalled();

    cycle.beginGeneration();
    await cycle.start("Queued");
    await cycle.stop();

    expect(publish.mock.calls).toEqual([["processing", "Queued"], ["active"]]);
  });

  it("keeps the successor processing after a delayed predecessor active write settles", async () => {
    const { cycle, settled, pendingCount, releaseNext } = createDeferredCycle();

    const started = cycle.start("First");
    await releaseNext();
    await started;
    const stopping = cycle.stop();
    cycle.beginGeneration();
    const successor = cycle.start("Queued");
    await waitForPending(pendingCount);

    expect(pendingCount()).toBe(1);
    expect(settled).toEqual(["processing"]);

    await releaseNext();
    await releaseNext();
    await stopping;
    await successor;

    expect(settled).toEqual(["processing", "active", "processing"]);
  });

  it("does not restart processing after the successor has finished", async () => {
    const { cycle, settled, pendingCount, releaseSettled } = createDeferredCycle();

    const started = cycle.start("First");
    await releaseSettled();
    await started;
    const predecessorStop = cycle.stop();
    cycle.beginGeneration();
    const successorStart = cycle.start("Queued");
    const successorStop = cycle.stop();
    await releaseSettled();
    for (let tick = 0; tick < 20; tick += 1) {
      await Promise.resolve();
    }

    expect(pendingCount()).toBe(0);
    expect(settled).toEqual(["processing", "active", "processing", "active"]);
    await Promise.all([predecessorStop, successorStart, successorStop, cycle.stop()]);
  });
});

function createDeferredCycle() {
  const gate = createSlackThreadStatusGate();
  gate.bind(() => ({ delivery: false, preview: false }));
  const settled: Array<"processing" | "active"> = [];
  const pending: Array<() => void> = [];
  const publish = vi.fn((status: "processing" | "active") => {
    return new Promise<boolean>((resolve) => {
      pending.push(() => {
        settled.push(status);
        resolve(true);
      });
    });
  });
  const cycle = createSlackSessionStatusCycle({
    gate,
    publish,
    onActiveRestoreFailed: vi.fn(),
  });
  return {
    cycle,
    settled,
    pendingCount: () => pending.length,
    async releaseNext() {
      await waitForPending(() => pending.length);
      const release = pending.shift();
      if (!release) {
        throw new Error("no status write is waiting");
      }
      release();
    },
    async releaseSettled() {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await waitForPending(() => pending.length);
        if (pending.length === 0) {
          return;
        }
        pending.shift()?.();
      }
    },
  };
}

async function waitForPending(pendingCount: () => number, minimum = 1) {
  for (let attempt = 0; attempt < 20 && pendingCount() < minimum; attempt += 1) {
    await Promise.resolve();
  }
}
