import { describe, it, expect, vi } from "vitest";
import { PaperScheduler } from "../../src/paper/paper-scheduler.js";

function createMinimalScheduler(
  regimeDetectorResolver?: () => { detect: (ohlcv: unknown[]) => string } | undefined,
) {
  const paperEngine = {
    listAccounts: vi.fn(() => [{ id: "paper-1", name: "Test", equity: 10000 }]),
    getAccountState: vi.fn(() => ({ equity: 10000, cash: 10000, positions: [] })),
    submitOrder: vi.fn(() => ({})),
    recordSnapshot: vi.fn(),
  };

  const onBarFn = vi.fn((_bar: unknown, ctx: { regime: string }) => {
    // Capture the regime from context
    return null;
  });

  const strategyRegistry = {
    list: vi.fn(() => [
      {
        id: "s1",
        name: "Test",
        level: "L2_PAPER",
        definition: {
          symbols: ["BTC/USDT"],
          timeframes: ["1h"],
          markets: ["crypto"],
          onBar: onBarFn,
        },
      },
    ]),
  };

  const dataProvider = {
    getOHLCV: vi.fn(async () => [
      { timestamp: 1, open: 100, high: 110, low: 90, close: 105, volume: 1000 },
    ]),
  };

  const scheduler = new PaperScheduler({
    paperEngine,
    strategyRegistry,
    dataProvider,
    regimeDetectorResolver,
  });

  return { scheduler, onBarFn };
}

describe("PaperScheduler regime wiring (Gap 4)", () => {
  it("uses regime from detector when available", async () => {
    const detector = { detect: vi.fn(() => "bull") };
    const { scheduler, onBarFn } = createMinimalScheduler(() => detector);

    await scheduler.tickAll();

    expect(detector.detect).toHaveBeenCalled();
    expect(onBarFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ regime: "bull" }),
    );
  });

  it("falls back to sideways when resolver returns undefined", async () => {
    const { scheduler, onBarFn } = createMinimalScheduler(() => undefined);

    await scheduler.tickAll();

    expect(onBarFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ regime: "sideways" }),
    );
  });

  it("falls back to sideways when no resolver configured", async () => {
    const { scheduler, onBarFn } = createMinimalScheduler(undefined);

    await scheduler.tickAll();

    expect(onBarFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ regime: "sideways" }),
    );
  });
});
