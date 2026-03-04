import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AgentEvent,
  AgentEventType,
  EventSubscriber,
} from "../../src/core/agent-event-store.js";
import {
  NotificationRouter,
  resolveEventLevel,
  formatNotificationText,
  buildNotification,
} from "../../src/core/notification-router.js";
import { parseCallbackData, processApproval } from "../../src/core/telegram-approval.js";

// ── Mock sendMessageTelegram ──

const mockSendTelegram = vi.fn().mockResolvedValue({ messageId: "123", chatId: "456" });
const mockEditTelegram = vi.fn().mockResolvedValue({ ok: true, messageId: "123", chatId: "456" });

vi.mock("../../../../src/telegram/send.js", () => ({
  sendMessageTelegram: (...args: unknown[]) => mockSendTelegram(...args),
  editMessageTelegram: (...args: unknown[]) => mockEditTelegram(...args),
}));

// ── Minimal AgentEventSqliteStore stub ──

function createMockEventStore() {
  const subscribers = new Set<EventSubscriber>();
  const events = new Map<string, AgentEvent>();

  return {
    subscribe(cb: EventSubscriber): () => void {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    addEvent(input: Omit<AgentEvent, "id" | "timestamp"> & { timestamp?: number }): AgentEvent {
      const event: AgentEvent = {
        ...input,
        id: `evt-${events.size + 1}-test`,
        timestamp: input.timestamp ?? Date.now(),
      };
      events.set(event.id, event);
      for (const sub of subscribers) sub(event);
      return event;
    },
    getEvent(id: string) {
      return events.get(id);
    },
    approve(id: string) {
      const event = events.get(id);
      if (!event || event.status !== "pending") return undefined;
      event.status = "approved";
      return event;
    },
    reject(id: string, reason?: string) {
      const event = events.get(id);
      if (!event || event.status !== "pending") return undefined;
      event.status = "rejected";
      return event;
    },
    listEvents: vi.fn().mockReturnValue([]),
    pendingCount: vi.fn().mockReturnValue(0),
    close: vi.fn(),
    _emit(event: AgentEvent) {
      for (const sub of subscribers) sub(event);
    },
    _subscriberCount() {
      return subscribers.size;
    },
  };
}

type MockStore = ReturnType<typeof createMockEventStore>;

function makeEvent(overrides?: Partial<AgentEvent>): AgentEvent {
  return {
    id: "evt-1-test",
    type: "trade_executed",
    title: "BTC/USDT Buy",
    detail: "Bought 0.1 BTC at $42,000",
    timestamp: Date.now(),
    status: "completed",
    ...overrides,
  };
}

describe("NotificationRouter", () => {
  let store: MockStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createMockEventStore();
  });

  // ── Test 1: resolveEventLevel maps event types correctly ──

  it("resolveEventLevel maps event types to correct levels", () => {
    expect(resolveEventLevel(makeEvent({ type: "emergency_stop" }))).toBe("critical");
    expect(resolveEventLevel(makeEvent({ type: "trade_pending" }))).toBe("action_required");
    expect(resolveEventLevel(makeEvent({ type: "trade_executed" }))).toBe("info");
    expect(resolveEventLevel(makeEvent({ type: "order_filled" }))).toBe("info");
    expect(resolveEventLevel(makeEvent({ type: "strategy_promoted" }))).toBe("info");
    expect(resolveEventLevel(makeEvent({ type: "system" }))).toBe("info");
  });

  // ── Test 2: formatNotificationText produces HTML with emoji and details ──

  it("formatNotificationText includes emoji, title, detail, and timestamp", () => {
    const event = makeEvent({
      type: "trade_executed",
      title: "BTC/USDT Buy",
      detail: "0.1 BTC at $42,000",
    });
    const text = formatNotificationText(event, "info");
    expect(text).toContain("<b>");
    expect(text).toContain("BTC/USDT Buy");
    expect(text).toContain("0.1 BTC at $42,000");
    expect(text).toContain("trade_executed");
  });

  // ── Test 3: buildNotification adds inline buttons for trade_pending ──

  it("buildNotification adds approve/reject buttons for trade_pending", () => {
    const event = makeEvent({
      type: "trade_pending",
      status: "pending",
      id: "evt-5-abc",
    });
    const notification = buildNotification(event);
    expect(notification.level).toBe("action_required");
    expect(notification.buttons).toBeDefined();
    expect(notification.buttons).toHaveLength(1);
    expect(notification.buttons![0]).toHaveLength(2);
    expect(notification.buttons![0]![0]!.callback_data).toBe("fin_approve:evt-5-abc");
    expect(notification.buttons![0]![1]!.callback_data).toBe("fin_reject:evt-5-abc");
  });

  // ── Test 4: buildNotification does NOT add buttons for non-pending events ──

  it("buildNotification does not add buttons for completed events", () => {
    const event = makeEvent({ type: "trade_executed", status: "completed" });
    const notification = buildNotification(event);
    expect(notification.buttons).toBeUndefined();
  });

  // ── Test 5: NotificationRouter subscribes and sends on event ──

  it("subscribes to event store and sends Telegram notification on new event", async () => {
    const router = new NotificationRouter(
      store as unknown as Parameters<
        typeof NotificationRouter extends new (a: infer A, ...args: never[]) => unknown
          ? never
          : never
      >[0],
      {
        telegramChatId: "12345",
      },
    );
    router.start();

    store.addEvent({
      type: "trade_executed",
      title: "ETH Buy",
      detail: "1 ETH at $3000",
      status: "completed",
    });

    // Wait for async route()
    await vi.waitFor(() => expect(mockSendTelegram).toHaveBeenCalledTimes(1));

    const [chatId, text, opts] = mockSendTelegram.mock.calls[0]!;
    expect(chatId).toBe("12345");
    expect(text).toContain("ETH Buy");
    expect(opts.textMode).toBe("html");

    router.stop();
  });

  // ── Test 6: NotificationRouter respects minLevel filter ──

  it("filters events below minLevel threshold", async () => {
    const router = new NotificationRouter(store as never, {
      telegramChatId: "12345",
      minLevel: "action_required",
    });
    router.start();

    // Info-level event should be filtered
    store.addEvent({
      type: "trade_executed",
      title: "ETH Buy",
      detail: "1 ETH at $3000",
      status: "completed",
    });

    // Wait a tick to ensure route() had time to run
    await new Promise((r) => setTimeout(r, 20));
    expect(mockSendTelegram).not.toHaveBeenCalled();

    // Critical event should go through
    store.addEvent({
      type: "emergency_stop",
      title: "Emergency!",
      detail: "All trading halted",
      status: "completed",
    });

    await vi.waitFor(() => expect(mockSendTelegram).toHaveBeenCalledTimes(1));

    router.stop();
  });

  // ── Test 7: NotificationRouter suppresses system events ──

  it("does not notify on system events (approve/reject notifications)", async () => {
    const router = new NotificationRouter(store as never, {
      telegramChatId: "12345",
    });
    router.start();

    store.addEvent({
      type: "system",
      title: "Approved: some trade",
      detail: "Action approved",
      status: "completed",
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(mockSendTelegram).not.toHaveBeenCalled();

    router.stop();
  });

  // ── Test 8: NotificationRouter tracks stats ──

  it("tracks sendCount and errorCount", async () => {
    const router = new NotificationRouter(store as never, {
      telegramChatId: "12345",
    });
    router.start();

    expect(router.getStats()).toEqual({ sendCount: 0, errorCount: 0, running: true });

    store.addEvent({
      type: "trade_executed",
      title: "Trade",
      detail: "detail",
      status: "completed",
    });

    await vi.waitFor(() => expect(router.getStats().sendCount).toBe(1));
    expect(router.getStats().errorCount).toBe(0);

    router.stop();
    expect(router.getStats().running).toBe(false);
  });

  // ── Test 9: NotificationRouter handles Telegram send errors gracefully ──

  it("increments errorCount on Telegram send failure", async () => {
    mockSendTelegram.mockRejectedValueOnce(new Error("Network error"));

    const router = new NotificationRouter(store as never, {
      telegramChatId: "12345",
    });
    router.start();

    store.addEvent({
      type: "trade_executed",
      title: "Trade",
      detail: "detail",
      status: "completed",
    });

    await vi.waitFor(() => expect(router.getStats().errorCount).toBe(1));
    expect(router.getStats().sendCount).toBe(0);

    router.stop();
  });

  // ── Test 10: stop() unsubscribes from event store ──

  it("stop() unsubscribes and prevents further notifications", async () => {
    const router = new NotificationRouter(store as never, {
      telegramChatId: "12345",
    });
    router.start();
    router.stop();

    store.addEvent({
      type: "trade_executed",
      title: "Trade",
      detail: "detail",
      status: "completed",
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });
});

// ── Telegram Approval Tests ──

describe("Telegram Approval", () => {
  // ── Test 11: parseCallbackData extracts action and eventId ──

  it("parseCallbackData parses approve and reject correctly", () => {
    expect(parseCallbackData("fin_approve:evt-1-abc")).toEqual({
      action: "approve",
      eventId: "evt-1-abc",
    });
    expect(parseCallbackData("fin_reject:evt-2-def")).toEqual({
      action: "reject",
      eventId: "evt-2-def",
    });
    expect(parseCallbackData("invalid")).toBeNull();
    expect(parseCallbackData("fin_unknown:evt-3")).toBeNull();
  });

  // ── Test 12: processApproval approves pending event ──

  it("processApproval approves a pending event and edits Telegram message", async () => {
    const store = createMockEventStore();
    store.addEvent({
      type: "trade_pending",
      title: "BTC Buy",
      detail: "Buy 1 BTC",
      status: "pending",
    });

    const result = await processApproval(store as never, {
      callbackData: "fin_approve:evt-1-test",
      chatId: "12345",
      messageId: 99,
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe("approve");
    expect(result.eventId).toBe("evt-1-test");
    expect(store.getEvent("evt-1-test")?.status).toBe("approved");
    expect(mockEditTelegram).toHaveBeenCalledOnce();
  });

  // ── Test 13: processApproval rejects pending event ──

  it("processApproval rejects a pending event", async () => {
    const store = createMockEventStore();
    store.addEvent({
      type: "trade_pending",
      title: "ETH Buy",
      detail: "Buy 10 ETH",
      status: "pending",
    });

    const result = await processApproval(store as never, {
      callbackData: "fin_reject:evt-1-test",
      chatId: "12345",
      messageId: 99,
      reason: "Too risky",
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe("reject");
    expect(store.getEvent("evt-1-test")?.status).toBe("rejected");
  });

  // ── Test 14: processApproval returns error for non-existent event ──

  it("processApproval returns error for missing event", async () => {
    const store = createMockEventStore();

    const result = await processApproval(store as never, {
      callbackData: "fin_approve:evt-999-none",
      chatId: "12345",
      messageId: 99,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  // ── Test 15: processApproval returns error for invalid callback data ──

  it("processApproval returns error for invalid callback data", async () => {
    const store = createMockEventStore();

    const result = await processApproval(store as never, {
      callbackData: "garbage",
      chatId: "12345",
      messageId: 99,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid callback data");
  });
});
