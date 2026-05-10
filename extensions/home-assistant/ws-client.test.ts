import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeAssistantStateStore } from "./state-store.js";
import { HomeAssistantClient, type ConnectionState, type WebSocketLike } from "./ws-client.js";

/**
 * Minimal HA-protocol-aware fake WebSocket. The harness lets a test step
 * through the lifecycle (open -> auth_required -> auth_ok -> subscribe ack ->
 * event push) without any real network traffic.
 */
class FakeWebSocket implements WebSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = FakeWebSocket.CONNECTING;
  readonly url: string;
  readonly sent: string[] = [];
  closeCalls = 0;

  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "" });
  }

  // -- test driver helpers --

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  simulateRawMessage(raw: string): void {
    this.onmessage?.({ data: raw });
  }

  simulateClose(code = 1006, reason = "abnormal"): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  /** Last message the client sent, parsed as JSON. */
  lastSent(): Record<string, unknown> {
    const last = this.sent.at(-1);
    if (last === undefined) {
      throw new Error("no messages sent");
    }
    return JSON.parse(last) as Record<string, unknown>;
  }

  /** Find the first sent message matching predicate. */
  findSent(
    predicate: (msg: Record<string, unknown>) => boolean,
  ): Record<string, unknown> | undefined {
    return this.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .find((msg) => predicate(msg));
  }
}

/**
 * Manual scheduler so reconnect/heartbeat timing is deterministic without
 * vitest fake timers (which would also affect microtasks vitest itself uses).
 */
class ManualScheduler {
  private nextHandle = 1;
  private pending = new Map<number, { fn: () => void; due: number }>();
  private now = 0;

  setTimeoutFn = (fn: () => void, ms: number): unknown => {
    const handle = this.nextHandle++;
    this.pending.set(handle, { fn, due: this.now + Math.max(0, ms) });
    return handle;
  };

  clearTimeoutFn = (handle: unknown): void => {
    if (typeof handle === "number") {
      this.pending.delete(handle);
    }
  };

  /** Advance virtual time and fire any timers that have come due. */
  advance(ms: number): void {
    this.now += ms;
    while (true) {
      const due = Array.from(this.pending.entries())
        .filter(([, t]) => t.due <= this.now)
        .sort((a, b) => a[1].due - b[1].due);
      if (due.length === 0) {
        break;
      }
      const [handle, { fn }] = due[0];
      this.pending.delete(handle);
      fn();
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

type Harness = {
  client: HomeAssistantClient;
  sockets: FakeWebSocket[];
  scheduler: ManualScheduler;
  store: HomeAssistantStateStore;
  states: ConnectionState[];
  logged: Array<{ level: string; message: string; data?: unknown }>;
};

function createHarness(
  options: { allowList?: string[]; heartbeatIntervalMs?: number; heartbeatTimeoutMs?: number } = {},
): Harness {
  const allowList = options.allowList ?? ["sensor.battery_soc", "switch.gate_main"];
  const sockets: FakeWebSocket[] = [];
  const scheduler = new ManualScheduler();
  const states: ConnectionState[] = [];
  const logged: Array<{ level: string; message: string; data?: unknown }> = [];

  const store = new HomeAssistantStateStore({ allowList });

  const client = new HomeAssistantClient({
    url: "ws://test/api/websocket",
    token: "fake-token",
    store,
    webSocketFactory: (url) => {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      return ws;
    },
    reconnect: { baseDelayMs: 1000, maxDelayMs: 30000 },
    heartbeat: {
      intervalMs: options.heartbeatIntervalMs ?? 30000,
      timeoutMs: options.heartbeatTimeoutMs ?? 10000,
    },
    setTimeoutFn: scheduler.setTimeoutFn,
    clearTimeoutFn: scheduler.clearTimeoutFn,
    logger: (entry) => logged.push(entry),
  });

  client.onStateChange((state) => states.push(state));

  return { client, sockets, scheduler, store, states, logged };
}

/**
 * Drive a freshly-started client all the way through auth + subscribe so the
 * test starts from the `subscribed` state. Returns the latest socket.
 */
function driveToSubscribed(harness: Harness): FakeWebSocket {
  harness.client.start();
  const ws = harness.sockets.at(-1)!;
  ws.simulateOpen();
  ws.simulateMessage({ type: "auth_required", ha_version: "test" });
  ws.simulateMessage({ type: "auth_ok", ha_version: "test" });
  // Client sends subscribe_events; ack with the same id.
  const subscribe = ws.findSent((m) => m.type === "subscribe_events");
  expect(subscribe, "client must send subscribe_events after auth_ok").toBeTruthy();
  ws.simulateMessage({ id: subscribe!.id, type: "result", success: true });
  return ws;
}

describe("HomeAssistantClient", () => {
  beforeEach(() => {
    // Nothing global -- harness owns all state.
  });

  afterEach(() => {
    // Tests must call client.stop() explicitly when needed.
  });

  describe("happy path: connect -> auth -> subscribe", () => {
    it("walks idle -> connecting -> authenticating -> subscribed", () => {
      const h = createHarness();
      expect(h.client.state).toBe("idle");

      h.client.start();
      expect(h.client.state).toBe("connecting");
      expect(h.sockets).toHaveLength(1);

      h.sockets[0].simulateOpen();
      h.sockets[0].simulateMessage({ type: "auth_required", ha_version: "test" });
      expect(h.client.state).toBe("authenticating");

      const authMsg = h.sockets[0].findSent((m) => m.type === "auth");
      expect(authMsg).toMatchObject({ type: "auth", access_token: "fake-token" });

      h.sockets[0].simulateMessage({ type: "auth_ok", ha_version: "test" });
      const subscribe = h.sockets[0].findSent((m) => m.type === "subscribe_events");
      expect(subscribe).toMatchObject({ type: "subscribe_events", event_type: "state_changed" });

      h.sockets[0].simulateMessage({ id: subscribe!.id, type: "result", success: true });
      expect(h.client.state).toBe("subscribed");
      expect(h.states).toEqual(["connecting", "authenticating", "subscribed"]);
    });

    it("forwards state_changed events to the store after subscribe", () => {
      const h = createHarness();
      const ws = driveToSubscribed(h);

      const newState = {
        entity_id: "sensor.battery_soc",
        state: "97",
        attributes: {},
        last_changed: "2026-05-10T19:00:00+00:00",
        last_updated: "2026-05-10T19:00:00+00:00",
      };

      ws.simulateMessage({
        id: 1,
        type: "event",
        event: {
          event_type: "state_changed",
          data: { entity_id: "sensor.battery_soc", old_state: null, new_state: newState },
        },
      });

      expect(h.store.get("sensor.battery_soc")).toEqual(newState);
    });
  });

  describe("auth failure", () => {
    it("transitions to degraded on auth_invalid and surfaces an explicit error", () => {
      const h = createHarness();
      h.client.start();
      h.sockets[0].simulateOpen();
      h.sockets[0].simulateMessage({ type: "auth_required" });
      h.sockets[0].simulateMessage({ type: "auth_invalid", message: "Bad token" });

      expect(h.client.state).toBe("degraded");
      expect(h.logged.some((l) => l.level === "error" && /auth/i.test(l.message))).toBe(true);
      // Must not reconnect after auth_invalid -- token won't change without operator action.
      expect(h.scheduler.pendingCount()).toBe(0);
    });
  });

  describe("heartbeat", () => {
    it("sends a ping after heartbeatIntervalMs and accepts pong", () => {
      const h = createHarness({ heartbeatIntervalMs: 30000, heartbeatTimeoutMs: 10000 });
      const ws = driveToSubscribed(h);

      h.scheduler.advance(30000);
      const ping = ws.findSent((m) => m.type === "ping");
      expect(ping).toBeTruthy();
      expect(typeof ping!.id).toBe("number");

      ws.simulateMessage({ id: ping!.id, type: "pong" });
      expect(h.client.state).toBe("subscribed");
    });

    it("recycles the socket on ping timeout and triggers reconnect", () => {
      const h = createHarness({ heartbeatIntervalMs: 30000, heartbeatTimeoutMs: 10000 });
      const ws = driveToSubscribed(h);

      h.scheduler.advance(30000);
      // Don't reply with pong; advance past timeout.
      h.scheduler.advance(10000);

      expect(ws.closeCalls).toBeGreaterThan(0);
      expect(h.client.state).toBe("degraded");

      // Reconnect timer should be scheduled.
      expect(h.scheduler.pendingCount()).toBeGreaterThan(0);
      h.scheduler.advance(1000); // base reconnect delay
      expect(h.sockets.length).toBe(2);
    });
  });

  describe("reconnect with exponential backoff", () => {
    it("attempt 1 backs off ~1s, attempt 5 caps at <=30s", () => {
      const h = createHarness();
      h.client.start();
      h.sockets[0].simulateOpen();
      h.sockets[0].simulateMessage({ type: "auth_required" });
      // Auth never completes -- socket drops.
      h.sockets[0].simulateClose();

      // attempt 1: 1000ms
      expect(h.client.computeReconnectDelay(1)).toBe(1000);
      // attempt 2: 2000ms
      expect(h.client.computeReconnectDelay(2)).toBe(2000);
      // attempt 5: 16000ms (1000 * 2^4)
      expect(h.client.computeReconnectDelay(5)).toBe(16000);
      // attempt 7: capped at 30000
      expect(h.client.computeReconnectDelay(7)).toBe(30000);
      // attempt 100: still capped
      expect(h.client.computeReconnectDelay(100)).toBe(30000);
    });

    it("schedules reconnect after socket close and creates a fresh socket", () => {
      const h = createHarness();
      h.client.start();
      h.sockets[0].simulateOpen();
      h.sockets[0].simulateClose();

      expect(h.client.state).toBe("degraded");
      // Backoff for attempt 1 is 1000ms.
      h.scheduler.advance(1000);
      expect(h.sockets.length).toBe(2);
      expect(h.client.state).toBe("connecting");
    });

    it("resets backoff after a successful subscribe", () => {
      const h = createHarness();
      driveToSubscribed(h);
      // Attempt counter should be zero after subscribe; computeReconnectDelay
      // for attempt 1 is the unaffected baseline.
      expect(h.client.computeReconnectDelay(1)).toBe(1000);

      // Now drop the connection and reconnect.
      h.sockets[0].simulateClose();
      h.scheduler.advance(1000);
      expect(h.sockets.length).toBe(2);
    });
  });

  describe("allow-list filtering at ingestion", () => {
    it("does not store state for entities outside allowList", () => {
      const h = createHarness({ allowList: ["sensor.battery_soc"] });
      const ws = driveToSubscribed(h);

      ws.simulateMessage({
        id: 1,
        type: "event",
        event: {
          event_type: "state_changed",
          data: {
            entity_id: "sensor.uninvited",
            old_state: null,
            new_state: {
              entity_id: "sensor.uninvited",
              state: "x",
              attributes: {},
            },
          },
        },
      });

      expect(h.store.get("sensor.uninvited")).toBeUndefined();
    });
  });

  describe("malformed payloads", () => {
    it("logs and ignores invalid JSON without crashing or transitioning state", () => {
      const h = createHarness();
      const ws = driveToSubscribed(h);

      ws.simulateRawMessage("not valid json");
      expect(h.client.state).toBe("subscribed");
      expect(h.logged.some((l) => l.level === "warn" && /parse|json/i.test(l.message))).toBe(true);
    });

    it("logs and ignores unexpected message shapes", () => {
      const h = createHarness();
      const ws = driveToSubscribed(h);

      ws.simulateMessage({ type: "totally-unknown", whatever: 1 });
      expect(h.client.state).toBe("subscribed");
    });

    it("ignores event payloads that are not state_changed", () => {
      const h = createHarness();
      const ws = driveToSubscribed(h);

      ws.simulateMessage({
        id: 1,
        type: "event",
        event: { event_type: "service_registered", data: {} },
      });
      expect(h.client.state).toBe("subscribed");
    });
  });

  describe("stop()", () => {
    it("transitions to disconnected, closes the socket, and cancels reconnect timers", () => {
      const h = createHarness();
      driveToSubscribed(h);

      h.client.stop();
      expect(h.client.state).toBe("disconnected");
      expect(h.sockets[0].closeCalls).toBeGreaterThan(0);
      expect(h.scheduler.pendingCount()).toBe(0);
    });

    it("does not reconnect after stop()", () => {
      const h = createHarness();
      driveToSubscribed(h);

      h.client.stop();
      h.scheduler.advance(60000);
      expect(h.sockets).toHaveLength(1);
    });
  });

  describe("integration: socket recycle after a heartbeat miss flushes stale state", () => {
    it("reset is called when a fresh subscribe completes after reconnect", () => {
      const h = createHarness({ heartbeatIntervalMs: 30000, heartbeatTimeoutMs: 10000 });
      const ws = driveToSubscribed(h);

      // Seed some state, then drop.
      ws.simulateMessage({
        id: 1,
        type: "event",
        event: {
          event_type: "state_changed",
          data: {
            entity_id: "sensor.battery_soc",
            old_state: null,
            new_state: {
              entity_id: "sensor.battery_soc",
              state: "97",
              attributes: {},
            },
          },
        },
      });
      expect(h.store.get("sensor.battery_soc")).toBeDefined();

      const resetSpy = vi.spyOn(h.store, "reset");
      ws.simulateClose();
      h.scheduler.advance(1000);

      // Walk new socket through auth + subscribe.
      const ws2 = h.sockets[1];
      ws2.simulateOpen();
      ws2.simulateMessage({ type: "auth_required" });
      ws2.simulateMessage({ type: "auth_ok" });
      const subscribe = ws2.findSent((m) => m.type === "subscribe_events");
      ws2.simulateMessage({ id: subscribe!.id, type: "result", success: true });

      expect(resetSpy).toHaveBeenCalled();
      expect(h.client.state).toBe("subscribed");
    });
  });
});
