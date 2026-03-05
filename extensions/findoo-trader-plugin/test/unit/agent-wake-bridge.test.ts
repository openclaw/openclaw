import { describe, it, expect, vi } from "vitest";
import { AgentWakeBridge } from "../../src/core/agent-wake-bridge.js";

function createBridge(opts?: { sessionKey?: string }) {
  const enqueue = vi.fn();
  const bridge = new AgentWakeBridge({
    enqueueSystemEvent: enqueue,
    sessionKeyResolver: () => opts?.sessionKey ?? "main:default",
  });
  return { bridge, enqueue };
}

describe("AgentWakeBridge", () => {
  it("onHealthAlert enqueues system event with correct context", () => {
    const { bridge, enqueue } = createBridge();
    bridge.onHealthAlert({ accountId: "acct-1", condition: "drawdown", value: 25.5 });

    expect(enqueue).toHaveBeenCalledOnce();
    const [text, opts] = enqueue.mock.calls[0]!;
    expect(text).toContain("[findoo-trader]");
    expect(text).toContain("drawdown");
    expect(text).toContain("acct-1");
    expect(opts.sessionKey).toBe("main:default");
    expect(opts.contextKey).toBe("cron:findoo:health:acct-1:drawdown");
  });

  it("onDailyBriefReady enqueues with daily-brief context key", () => {
    const { bridge, enqueue } = createBridge();
    bridge.onDailyBriefReady({ totalPnl: 150.5, strategyCount: 3 });

    expect(enqueue).toHaveBeenCalledOnce();
    const [text, opts] = enqueue.mock.calls[0]!;
    expect(text).toContain("Daily brief ready");
    expect(text).toContain("3 strategies");
    expect(opts.contextKey).toBe("cron:findoo:daily-brief");
  });

  it("onSeedBacktestComplete enqueues with seed context key", () => {
    const { bridge, enqueue } = createBridge();
    bridge.onSeedBacktestComplete({ completed: 5, qualified: 3 });

    expect(enqueue).toHaveBeenCalledOnce();
    const [text, opts] = enqueue.mock.calls[0]!;
    expect(text).toContain("5 completed");
    expect(text).toContain("3 qualified");
    expect(opts.contextKey).toBe("cron:findoo:seed-backtest");
  });

  it("onPromotionReady enqueues with strategy-specific context key", () => {
    const { bridge, enqueue } = createBridge();
    bridge.onPromotionReady({ strategyId: "sma-crossover", from: "L1_BACKTEST", to: "L2_PAPER" });

    expect(enqueue).toHaveBeenCalledOnce();
    const [text, opts] = enqueue.mock.calls[0]!;
    expect(text).toContain("sma-crossover");
    expect(text).toContain("L1_BACKTEST → L2_PAPER");
    expect(opts.contextKey).toBe("cron:findoo:promotion:sma-crossover");
  });

  it("onApprovalNeeded enqueues with approval context key", () => {
    const { bridge, enqueue } = createBridge();
    bridge.onApprovalNeeded({ strategyId: "macd-div", strategyName: "MACD Divergence" });

    expect(enqueue).toHaveBeenCalledOnce();
    const [text, opts] = enqueue.mock.calls[0]!;
    expect(text).toContain("MACD Divergence");
    expect(text).toContain("L3_LIVE");
    expect(text).toContain("user confirmation");
    expect(opts.contextKey).toBe("cron:findoo:approval:macd-div");
  });

  it("skips silently when sessionKey is undefined", () => {
    const enqueue = vi.fn();
    const bridge = new AgentWakeBridge({
      enqueueSystemEvent: enqueue,
      sessionKeyResolver: () => undefined,
    });

    bridge.onHealthAlert({ accountId: "acct-1", condition: "drawdown", value: 25 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("catches enqueue errors silently", () => {
    const enqueue = vi.fn().mockImplementation(() => {
      throw new Error("invalid session");
    });
    const bridge = new AgentWakeBridge({
      enqueueSystemEvent: enqueue,
      sessionKeyResolver: () => "main:default",
    });

    // Should not throw
    expect(() =>
      bridge.onHealthAlert({ accountId: "a", condition: "test", value: 0 }),
    ).not.toThrow();
  });
});
