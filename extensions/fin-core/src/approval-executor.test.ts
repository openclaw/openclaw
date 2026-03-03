import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApprovalExecutor } from "./approval-executor.js";
import type { AgentEvent, AgentEventStore } from "./agent-event-store.js";
import type { UnifiedExchangeAdapter } from "./adapters/adapter-interface.js";
import type { OrderResult } from "./types.js";

/** Helper to build a pending trade event with actionParams. */
function pendingEvent(overrides?: Partial<AgentEvent>): AgentEvent {
  return {
    id: "evt-1-abc",
    type: "trade_pending",
    title: "BUY 0.5 BTC/USDT",
    detail: "Requires user confirmation",
    timestamp: Date.now(),
    status: "pending",
    actionParams: {
      exchange: "binance",
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 0.5,
    },
    ...overrides,
  };
}

function mockOrderResult(overrides?: Partial<OrderResult>): OrderResult {
  return {
    orderId: "ord-123",
    exchangeId: "binance",
    symbol: "BTC/USDT",
    side: "buy",
    type: "market",
    amount: 0.5,
    filledAmount: 0.5,
    price: 60000,
    status: "closed",
    timestamp: Date.now(),
    ...overrides,
  };
}

function createMockStore(event?: AgentEvent | undefined) {
  return {
    getEvent: vi.fn().mockReturnValue(event),
    approve: vi.fn().mockReturnValue(event ? { ...event, status: "approved" } : undefined),
    reject: vi.fn().mockReturnValue(event ? { ...event, status: "rejected" } : undefined),
    listEvents: vi.fn().mockReturnValue(event ? [event] : []),
    addEvent: vi.fn(),
  } as unknown as AgentEventStore;
}

function createMockAdapter(orderResult?: OrderResult) {
  return {
    exchangeId: "binance",
    marketType: "crypto" as const,
    isTestnet: false,
    placeOrder: vi.fn().mockResolvedValue(orderResult ?? mockOrderResult()),
    cancelOrder: vi.fn(),
    fetchBalance: vi.fn(),
    fetchPositions: vi.fn(),
    fetchTicker: vi.fn(),
    fetchOpenOrders: vi.fn(),
    healthCheck: vi.fn(),
  } satisfies UnifiedExchangeAdapter;
}

describe("ApprovalExecutor", () => {
  let store: ReturnType<typeof createMockStore>;
  let adapter: ReturnType<typeof createMockAdapter>;
  let adapterFactory: ReturnType<typeof vi.fn>;
  let executor: ApprovalExecutor;

  beforeEach(() => {
    store = createMockStore(pendingEvent());
    adapter = createMockAdapter();
    adapterFactory = vi.fn().mockReturnValue(adapter);
    executor = new ApprovalExecutor(store, adapterFactory);
  });

  // ── approve() ──

  it("approve() — reads pending event, executes trade via adapter, updates event", async () => {
    const result = await executor.approve("evt-1-abc");

    expect(store.getEvent).toHaveBeenCalledWith("evt-1-abc");
    expect(adapterFactory).toHaveBeenCalledWith("binance");
    expect(adapter.placeOrder).toHaveBeenCalledWith({
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 0.5,
    });
    expect(store.approve).toHaveBeenCalledWith("evt-1-abc");
    expect(result.action).toBe("approved");
    expect(result.eventId).toBe("evt-1-abc");
    expect(result.order).toBeDefined();
    expect(result.order!.orderId).toBe("ord-123");
    expect(result.error).toBeUndefined();
  });

  it("approve() — handles exchange error gracefully", async () => {
    adapter.placeOrder.mockRejectedValue(new Error("Insufficient balance"));

    const result = await executor.approve("evt-1-abc");

    expect(result.action).toBe("approved");
    expect(result.eventId).toBe("evt-1-abc");
    expect(result.error).toBe("Insufficient balance");
    expect(result.order).toBeUndefined();
    // Event should NOT be approved on exchange failure
    expect(store.approve).not.toHaveBeenCalled();
  });

  it("approve() — returns error for non-existent event", async () => {
    store = createMockStore(undefined);
    executor = new ApprovalExecutor(store, adapterFactory);

    const result = await executor.approve("evt-999");

    expect(result.action).toBe("rejected");
    expect(result.eventId).toBe("evt-999");
    expect(result.error).toContain("not found");
    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it("approve() — returns error for non-pending event (already approved)", async () => {
    const approvedEvent = pendingEvent({ status: "approved" });
    store = createMockStore(approvedEvent);
    executor = new ApprovalExecutor(store, adapterFactory);

    const result = await executor.approve("evt-1-abc");

    expect(result.action).toBe("rejected");
    expect(result.eventId).toBe("evt-1-abc");
    expect(result.error).toContain("not pending");
    expect(adapterFactory).not.toHaveBeenCalled();
  });

  // ── reject() ──

  it("reject() — marks event as rejected", async () => {
    const result = await executor.reject("evt-1-abc");

    expect(store.reject).toHaveBeenCalledWith("evt-1-abc", undefined);
    expect(result.action).toBe("rejected");
    expect(result.eventId).toBe("evt-1-abc");
    expect(result.error).toBeUndefined();
  });

  it("reject() — with custom reason", async () => {
    const result = await executor.reject("evt-1-abc", "Too risky");

    expect(store.reject).toHaveBeenCalledWith("evt-1-abc", "Too risky");
    expect(result.action).toBe("rejected");
    expect(result.eventId).toBe("evt-1-abc");
  });

  // ── expireStale() ──

  it("expireStale() — expires events older than maxAge", async () => {
    const oldEvent = pendingEvent({
      id: "evt-old",
      timestamp: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
    });
    const recentEvent = pendingEvent({
      id: "evt-recent",
      timestamp: Date.now() - 1 * 60 * 60 * 1000, // 1 hour ago
    });

    store.listEvents.mockReturnValue([oldEvent, recentEvent]);
    store.reject.mockReturnValue({ ...oldEvent, status: "rejected" });
    executor = new ApprovalExecutor(store, adapterFactory);

    const count = await executor.expireStale();

    expect(count).toBe(1);
    expect(store.reject).toHaveBeenCalledWith("evt-old", "expired");
    expect(store.reject).not.toHaveBeenCalledWith("evt-recent", expect.anything());
  });

  it("expireStale() — does not expire recent events", async () => {
    const recentEvent = pendingEvent({
      id: "evt-recent",
      timestamp: Date.now() - 1 * 60 * 60 * 1000, // 1 hour ago
    });

    store.listEvents.mockReturnValue([recentEvent]);
    executor = new ApprovalExecutor(store, adapterFactory);

    const count = await executor.expireStale();

    expect(count).toBe(0);
    expect(store.reject).not.toHaveBeenCalled();
  });
});
