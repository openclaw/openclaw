/**
 * ApprovalExecutor — processes user approve/reject decisions on pending events.
 * Bridges the event store (pending trade events) with exchange adapters for execution.
 */

import type { AgentEventStore } from "./agent-event-store.js";
import type { UnifiedExchangeAdapter } from "./adapters/adapter-interface.js";
import type { AdapterOrderParams } from "./adapters/adapter-interface.js";
import type { ApprovalResult } from "./types.js";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export class ApprovalExecutor {
  constructor(
    private eventStore: AgentEventStore,
    private adapterFactory: (exchangeId: string) => UnifiedExchangeAdapter | undefined,
  ) {}

  /** Approve a pending event and execute the trade via the appropriate adapter. */
  async approve(eventId: string): Promise<ApprovalResult> {
    const event = this.eventStore.getEvent(eventId);

    if (!event) {
      return { eventId, action: "rejected", error: `Event ${eventId} not found` };
    }

    if (event.status !== "pending") {
      return { eventId, action: "rejected", error: `Event ${eventId} is not pending (status: ${event.status})` };
    }

    const params = event.actionParams;
    if (!params) {
      return { eventId, action: "rejected", error: `Event ${eventId} has no actionParams` };
    }

    const exchangeId = params.exchange as string | undefined;
    if (!exchangeId) {
      return { eventId, action: "rejected", error: `Event ${eventId} missing exchange in actionParams` };
    }

    const adapter = this.adapterFactory(exchangeId);
    if (!adapter) {
      return { eventId, action: "rejected", error: `No adapter found for exchange: ${exchangeId}` };
    }

    // Build order params from actionParams.
    const orderParams: AdapterOrderParams = {
      symbol: params.symbol as string,
      side: params.side as "buy" | "sell",
      type: (params.type as "market" | "limit") ?? "market",
      amount: params.amount as number,
    };
    if (params.price != null) orderParams.price = params.price as number;

    try {
      const order = await adapter.placeOrder(orderParams);
      this.eventStore.approve(eventId);
      return { eventId, action: "approved", order };
    } catch (err) {
      // Exchange error — do not approve the event; let the user retry.
      return { eventId, action: "approved", error: (err as Error).message };
    }
  }

  /** Reject a pending event with an optional reason. */
  async reject(eventId: string, reason?: string): Promise<ApprovalResult> {
    const updated = this.eventStore.reject(eventId, reason);

    if (!updated) {
      return { eventId, action: "rejected", error: `Event ${eventId} not found or not pending` };
    }

    return { eventId, action: "rejected" };
  }

  /**
   * Expire pending events older than maxAgeMs (default 24h).
   * Returns the count of expired events.
   */
  async expireStale(maxAgeMs: number = DEFAULT_MAX_AGE_MS): Promise<number> {
    const pendingEvents = this.eventStore.listEvents({ status: "pending" });
    const now = Date.now();
    let count = 0;

    for (const event of pendingEvents) {
      if (now - event.timestamp >= maxAgeMs) {
        this.eventStore.reject(event.id, "expired");
        count++;
      }
    }

    return count;
  }
}
