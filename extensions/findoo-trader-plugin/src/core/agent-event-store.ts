/**
 * In-memory store for agent events with SSE subscriber support.
 * Events track trades, alerts, strategy promotions, approval requests, etc.
 */

export type AgentEventType =
  | "trade_executed"
  | "trade_pending"
  | "alert_triggered"
  | "strategy_promoted"
  | "strategy_killed"
  | "order_filled"
  | "order_cancelled"
  | "emergency_stop"
  | "system";

export type AgentEventStatus = "completed" | "pending" | "approved" | "rejected";

export interface AgentEvent {
  id: string;
  type: AgentEventType;
  title: string;
  detail: string;
  timestamp: number;
  status: AgentEventStatus;
  /** Original action parameters for re-execution on approval. */
  actionParams?: Record<string, unknown>;
}

export type EventSubscriber = (event: AgentEvent) => void;

const MAX_EVENTS = 500;

export class AgentEventStore {
  private events: AgentEvent[] = [];
  private subscribers = new Set<EventSubscriber>();
  private counter = 0;

  /** Add an event and notify all subscribers. */
  addEvent(input: Omit<AgentEvent, "id" | "timestamp"> & { timestamp?: number }): AgentEvent {
    const event: AgentEvent = {
      ...input,
      id: `evt-${++this.counter}-${Date.now().toString(36)}`,
      timestamp: input.timestamp ?? Date.now(),
    };

    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }

    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // Subscriber errors should not break the store.
      }
    }

    return event;
  }

  /** List events, optionally filtered by type. Newest first. */
  listEvents(filter?: { type?: AgentEventType; status?: AgentEventStatus }): AgentEvent[] {
    let result = [...this.events];
    if (filter?.type) {
      result = result.filter((e) => e.type === filter.type);
    }
    if (filter?.status) {
      result = result.filter((e) => e.status === filter.status);
    }
    return result.reverse();
  }

  /** Get a single event by ID. */
  getEvent(id: string): AgentEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  /** Approve a pending event. Returns the updated event or undefined if not found. */
  approve(id: string): AgentEvent | undefined {
    const event = this.events.find((e) => e.id === id);
    if (!event || event.status !== "pending") return undefined;
    event.status = "approved";

    const notification: AgentEvent = {
      ...event,
      id: `evt-${++this.counter}-${Date.now().toString(36)}`,
      type: "system",
      title: `Approved: ${event.title}`,
      detail: `Action approved by user`,
      timestamp: Date.now(),
      status: "completed",
    };
    this.events.push(notification);

    for (const sub of this.subscribers) {
      try {
        sub(notification);
      } catch {}
    }

    return event;
  }

  /** Reject a pending event. Returns the updated event or undefined if not found. */
  reject(id: string, reason?: string): AgentEvent | undefined {
    const event = this.events.find((e) => e.id === id);
    if (!event || event.status !== "pending") return undefined;
    event.status = "rejected";

    const notification: AgentEvent = {
      ...event,
      id: `evt-${++this.counter}-${Date.now().toString(36)}`,
      type: "system",
      title: `Rejected: ${event.title}`,
      detail: reason ?? "Action rejected by user",
      timestamp: Date.now(),
      status: "completed",
    };
    this.events.push(notification);

    for (const sub of this.subscribers) {
      try {
        sub(notification);
      } catch {}
    }

    return event;
  }

  /** Subscribe to new events. Returns an unsubscribe function. */
  subscribe(callback: EventSubscriber): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  /** Get the count of pending events. */
  pendingCount(): number {
    return this.events.filter((e) => e.status === "pending").length;
  }
}
