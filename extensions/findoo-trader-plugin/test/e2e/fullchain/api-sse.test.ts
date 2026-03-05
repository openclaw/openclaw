/**
 * Phase F — B8: SSE stream API full-chain E2E tests.
 * Validates all text/event-stream endpoints against a real server stack.
 */

import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("ccxt", () => {
  class MockExchange {
    setSandboxMode = vi.fn();
    close = vi.fn();
  }
  return {
    binance: MockExchange,
    okx: MockExchange,
    bybit: MockExchange,
    hyperliquid: MockExchange,
  };
});

import { createFullChainServer, type FullChainContext } from "./harness.js";

/**
 * Read the first SSE `data:` line from an event-stream URL.
 * Destroys the connection after the first event to avoid hanging.
 */
function readFirstSseEvent(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.get(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search },
      (res) => {
        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          const match = buf.match(/data: (.+)\n/);
          if (match) {
            req.destroy();
            resolve(match[1]!);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    setTimeout(() => {
      req.destroy();
      reject(new Error("SSE timeout"));
    }, 5000);
  });
}

/**
 * Read SSE events until a condition is met or timeout.
 * Returns all collected `data:` payloads.
 */
function readSseEventsUntil(
  url: string,
  condition: (events: string[]) => boolean,
  timeoutMs = 5000,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const events: string[] = [];
    const req = http.get(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search },
      (res) => {
        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          // Extract all data lines from accumulated buffer
          const lines = buf.split("\n");
          // Keep the last incomplete line in the buffer
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const match = line.match(/^data: (.+)$/);
            if (match) {
              events.push(match[1]!);
              if (condition(events)) {
                req.destroy();
                resolve(events);
                return;
              }
            }
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, timeoutMs);
  });
}

describe("B8 — SSE stream API full-chain", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  it("config/stream sends initial JSON data", async () => {
    const raw = await readFirstSseEvent(`${ctx.baseUrl}/api/v1/finance/config/stream`);
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data).toHaveProperty("generatedAt");
    expect(data).toHaveProperty("exchanges");
    expect(data).toHaveProperty("trading");
    expect(data).toHaveProperty("plugins");
  });

  it("trading/stream sends trading JSON data", async () => {
    const raw = await readFirstSseEvent(`${ctx.baseUrl}/api/v1/finance/trading/stream`);
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data).toHaveProperty("summary");
    expect(data).toHaveProperty("positions");
    expect(data).toHaveProperty("orders");
    expect(data).toHaveProperty("strategies");
  });

  it("events/stream sends events with pendingCount", async () => {
    const raw = await readFirstSseEvent(`${ctx.baseUrl}/api/v1/finance/events/stream`);
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data).toHaveProperty("events");
    expect(data).toHaveProperty("pendingCount");
    expect(typeof data.pendingCount).toBe("number");
  });

  it("events/stream pushes new event via eventStore.addEvent", async () => {
    // Start listening for SSE events
    const eventPromise = readSseEventsUntil(
      `${ctx.baseUrl}/api/v1/finance/events/stream`,
      (collected) => collected.length >= 2,
      3000,
    );

    // Give the SSE connection time to establish and subscribe
    await new Promise((r) => setTimeout(r, 200));

    // Inject a new event through the event store
    ctx.services.eventStore.addEvent({
      type: "system",
      title: "Test SSE push",
      detail: "Event injected during SSE test",
      status: "completed",
    });

    const events = await eventPromise;
    expect(events.length).toBeGreaterThanOrEqual(2);

    // First event is the initial snapshot
    const initial = JSON.parse(events[0]!) as Record<string, unknown>;
    expect(initial).toHaveProperty("events");
    expect(initial).toHaveProperty("pendingCount");

    // Second event should be the pushed event notification
    const pushed = JSON.parse(events[1]!) as Record<string, unknown>;
    expect(pushed.type).toBe("new_event");
    expect(pushed).toHaveProperty("event");
    expect(pushed).toHaveProperty("pendingCount");
  });

  it("strategy/stream sends strategy data", async () => {
    const raw = await readFirstSseEvent(`${ctx.baseUrl}/api/v1/finance/strategy/stream`);
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data).toHaveProperty("pipeline");
    expect(data).toHaveProperty("strategies");
    expect(data).toHaveProperty("gates");
  });

  it("backtest/progress/stream connects and receives progress event", async () => {
    // The backtest progress SSE endpoint only sends data when backtests are active.
    // We inject a progress event via the progressStore to trigger a data push.
    const eventPromise = readSseEventsUntil(
      `${ctx.baseUrl}/api/v1/finance/backtest/progress/stream`,
      (collected) => collected.length >= 1,
      3000,
    );

    // Give the SSE connection time to establish and subscribe
    await new Promise((r) => setTimeout(r, 200));

    // Inject a backtest progress event to trigger SSE push
    ctx.services.progressStore.report({
      strategyId: "test-bt-sse",
      status: "running",
      percentComplete: 50,
      currentBar: 500,
      totalBars: 1000,
      currentEquity: 10000,
    });

    const events = await eventPromise;
    expect(events.length).toBeGreaterThanOrEqual(1);
    const data = JSON.parse(events[0]!) as Record<string, unknown>;
    expect(data.type).toBe("progress");
    expect(data.strategyId).toBe("test-bt-sse");
  });

  it("fund/stream sends fund data", async () => {
    const raw = await readFirstSseEvent(`${ctx.baseUrl}/api/v1/fund/stream`);
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data).toHaveProperty("status");
    expect(data).toHaveProperty("leaderboard");
    expect(data).toHaveProperty("allocations");
    expect(data).toHaveProperty("risk");
    const status = data.status as Record<string, unknown>;
    expect(status).toHaveProperty("totalEquity");
  });
});
