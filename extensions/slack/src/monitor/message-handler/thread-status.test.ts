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

  it("reasserts processing when an older stop lands after the successor started", async () => {
    const gate = createSlackThreadStatusGate();
    gate.bind(() => ({ delivery: false, preview: false }));
    let releaseActive: (() => void) | undefined;
    const publish = vi.fn(
      (status: "processing" | "active") =>
        new Promise<boolean>((resolve) => {
          if (status === "active" && !releaseActive) {
            releaseActive = () => resolve(true);
            return;
          }
          resolve(true);
        }),
    );
    const cycle = createSlackSessionStatusCycle({
      gate,
      publish,
      onActiveRestoreFailed: vi.fn(),
    });

    await cycle.start("First");
    const stopping = cycle.stop();
    cycle.beginGeneration();
    await cycle.start("Queued");
    releaseActive?.();
    await stopping;

    expect(publish.mock.calls.map((call) => call[0])).toEqual([
      "processing",
      "active",
      "processing",
    ]);
  });
});
