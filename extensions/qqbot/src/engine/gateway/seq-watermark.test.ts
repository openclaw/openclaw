import { describe, expect, it } from "vitest";
import { SeqWatermark } from "./seq-watermark.js";

describe("SeqWatermark", () => {
  it("starts empty and accepts a restored seed", () => {
    const w = new SeqWatermark();
    expect(w.value()).toBeNull();
    w.reset(41);
    expect(w.value()).toBe(41);
    w.reset(null);
    expect(w.value()).toBeNull();
  });

  it("commits observed non-message seqs immediately", () => {
    const w = new SeqWatermark();
    w.observe(1);
    w.observe(2);
    expect(w.value()).toBe(2);
    // Out-of-order duplicates never move the watermark backwards.
    w.observe(1);
    expect(w.value()).toBe(2);
  });

  it("holds the watermark below an unsettled message seq", () => {
    const w = new SeqWatermark();
    w.observe(1);
    w.register(2);
    expect(w.value()).toBe(1);
    w.settle(2);
    expect(w.value()).toBe(2);
  });

  // Regression: committing message seqs at frame receipt let RESUME skip
  // queued/in-flight messages after a restart or handler failure.
  it("keeps replaying the oldest unsettled message even when later frames arrive", () => {
    const w = new SeqWatermark();
    w.register(2);
    w.observe(3);
    w.register(4);
    w.settle(4);
    // Seq 2 is still in flight: RESUME must ask for replay from seq 1.
    expect(w.value()).toBe(1);
    w.settle(2);
    expect(w.value()).toBe(4);
  });

  it("settling out of order advances to the highest fully-settled seq", () => {
    const w = new SeqWatermark();
    w.register(10);
    w.register(11);
    w.register(12);
    w.settle(11);
    expect(w.value()).toBe(9);
    w.settle(10);
    expect(w.value()).toBe(11);
    w.settle(12);
    expect(w.value()).toBe(12);
  });

  it("ignores settles for seqs that were never registered", () => {
    const w = new SeqWatermark();
    w.observe(5);
    w.settle(99);
    expect(w.value()).toBe(5);
  });

  it("keeps the heartbeat receive cursor at the latest seq while messages are pending", () => {
    const w = new SeqWatermark();
    w.observe(1);
    w.register(2);
    w.observe(3);
    // Heartbeats report the receive cursor; RESUME uses the watermark.
    expect(w.latest()).toBe(3);
    expect(w.value()).toBe(1);
    w.settle(2);
    expect(w.latest()).toBe(3);
    expect(w.value()).toBe(3);
    w.reset(null);
    expect(w.latest()).toBeNull();
  });

  it("clears pending seqs on reset so a new session starts clean", () => {
    const w = new SeqWatermark();
    w.register(7);
    w.reset(null);
    expect(w.value()).toBeNull();
    w.observe(1);
    expect(w.value()).toBe(1);
  });
});
