import { describe, it, expect, vi, beforeEach } from "vitest";
import { FundLaunchOrchestrator, type LaunchPhase } from "./fund-launch-orchestrator.js";

// ── Mock factories ──

function createMockEventStore() {
  const events: Array<Record<string, unknown>> = [];
  return {
    addEvent: vi.fn((input: Record<string, unknown>) => {
      const event = {
        id: `evt-${events.length + 1}-${Date.now()}`,
        ...input,
        timestamp: Date.now(),
      };
      events.push(event);
      return event;
    }),
    listEvents: vi.fn(() => events),
    events,
  };
}

function createMockStrategyRegistry() {
  const records = new Map<string, Record<string, unknown>>();
  return {
    create: vi.fn((def: Record<string, unknown>) => {
      const record = { id: def.id as string, name: def.name as string, level: "L0_INCUBATE" };
      records.set(record.id, record);
      return record;
    }),
    list: vi.fn(() => [...records.values()]),
    get: vi.fn((id: string) => records.get(id)),
    updateLevel: vi.fn((id: string, level: string) => {
      const rec = records.get(id);
      if (rec) rec.level = level;
    }),
    updateBacktest: vi.fn(),
    records,
  };
}

function createMockPaperEngine() {
  return {
    listAccounts: vi.fn(() => [{ id: "acc-1", name: "Demo", equity: 100000 }]),
    createAccount: vi.fn(() => ({ id: "acc-new" })),
    submitOrder: vi.fn(() => ({ orderId: "paper-ord-1" })),
  };
}

// ── Tests ──

describe("FundLaunchOrchestrator", () => {
  let eventStore: ReturnType<typeof createMockEventStore>;
  let strategyRegistry: ReturnType<typeof createMockStrategyRegistry>;
  let paperEngine: ReturnType<typeof createMockPaperEngine>;
  let orchestrator: FundLaunchOrchestrator;

  beforeEach(() => {
    eventStore = createMockEventStore();
    strategyRegistry = createMockStrategyRegistry();
    paperEngine = createMockPaperEngine();
    orchestrator = new FundLaunchOrchestrator({
      eventStore,
      strategyRegistry,
      paperEngine,
    } as unknown as ConstructorParameters<typeof FundLaunchOrchestrator>[0]);
  });

  it("starts in idle state", () => {
    const state = orchestrator.getState();
    expect(state.phase).toBe("idle");
    expect(state.mode).toBeNull();
    expect(state.runId).toBeNull();
  });

  it("launch() returns immediately with running state", async () => {
    const state = await orchestrator.launch("firstRun");
    expect(state.mode).toBe("firstRun");
    expect(state.runId).toBeTruthy();
    expect(state.startedAt).toBeTypeOf("number");
  });

  it("launch() is idempotent while running", async () => {
    const state1 = await orchestrator.launch("firstRun");
    const state2 = await orchestrator.launch("demo");
    // Second call should return same runId (didn't restart)
    expect(state2.runId).toBe(state1.runId);
  });

  it("runs full sequence with 3 strategies created", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await orchestrator.launch("firstRun");

    // Fast-forward through all sleeps (total ~20s of sleep)
    await vi.advanceTimersByTimeAsync(30_000);

    // Verify 3 strategies were created
    expect(strategyRegistry.create).toHaveBeenCalledTimes(3);

    // Verify backtests were recorded for all 3
    expect(strategyRegistry.updateBacktest).toHaveBeenCalledTimes(3);

    // Verify level updates (2 passing → L1, best → L2)
    const levelCalls = strategyRegistry.updateLevel.mock.calls;
    const l1Calls = levelCalls.filter((c) => c[1] === "L1_BACKTEST");
    expect(l1Calls.length).toBe(2); // BTC趋势 + ETH均值v2

    const l2Calls = levelCalls.filter((c) => c[1] === "L2_PAPER");
    expect(l2Calls.length).toBe(1); // BTC趋势 promoted to L2

    // Verify events were emitted (scanning + 3 creates + 3 backtest-start + 3 backtest-result + promote + paper trade + approval + ...)
    expect(eventStore.addEvent.mock.calls.length).toBeGreaterThanOrEqual(8);

    // Verify approval event was emitted with pending status
    const approvalEvent = eventStore.events.find(
      (e) =>
        e.status === "pending" &&
        (e.actionParams as Record<string, unknown>)?.action === "fund_launch_l3",
    );
    expect(approvalEvent).toBeTruthy();

    vi.useRealTimers();
  });

  it("cleanup kills demo strategies and resets state", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await orchestrator.launch("demo");
    await vi.advanceTimersByTimeAsync(30_000);

    const result = orchestrator.cleanup();
    expect(result.removed).toBeGreaterThan(0);

    const state = orchestrator.getState();
    expect(state.phase).toBe("idle");
    expect(state.strategiesCreated).toEqual([]);

    vi.useRealTimers();
  });

  it("onApproval resolves the awaiting phase", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await orchestrator.launch("firstRun");

    // Advance to just before approval (scanning 2s + creates 1.5s + sleeps ~12s + promote 2s + paper 2s)
    await vi.advanceTimersByTimeAsync(25_000);

    // Should be in awaiting_approval phase
    const stateBeforeApproval = orchestrator.getState();
    expect(stateBeforeApproval.phase).toBe("awaiting_approval");

    // Find the approval event
    const approvalEvent = eventStore.events.find(
      (e) => (e.actionParams as Record<string, unknown>)?.action === "fund_launch_l3",
    );
    expect(approvalEvent).toBeTruthy();

    // Approve it
    orchestrator.onApproval(approvalEvent!.id as string);

    // Let the completion phase run
    await vi.advanceTimersByTimeAsync(1000);

    const stateAfter = orchestrator.getState();
    expect(stateAfter.phase).toBe("complete");
    expect(stateAfter.completedAt).toBeTypeOf("number");

    vi.useRealTimers();
  });

  it("emits events in correct order with proper feed types", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await orchestrator.launch("firstRun");
    await vi.advanceTimersByTimeAsync(30_000);

    const feedTypes = eventStore.events.map((e) => e.feedType);

    // First event should be 'brief' (scanning)
    expect(feedTypes[0]).toBe("brief");

    // Should contain evo events (strategy creation + backtest pass)
    expect(feedTypes.filter((t) => t === "evo").length).toBeGreaterThanOrEqual(2);

    // Should contain risk events (failed backtest)
    expect(feedTypes.filter((t) => t === "risk").length).toBeGreaterThanOrEqual(1);

    // Should contain buy event (paper trade)
    expect(feedTypes.filter((t) => t === "buy").length).toBeGreaterThanOrEqual(1);

    // Should contain appr event (approval card)
    expect(feedTypes.filter((t) => t === "appr").length).toBe(1);

    vi.useRealTimers();
  });
});
