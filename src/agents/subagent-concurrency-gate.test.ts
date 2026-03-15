import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireConcurrencySlot,
  configureConcurrencyGate,
  getConcurrencyStats,
  releaseConcurrencySlot,
  resetConcurrencyGateForTests,
} from "./subagent-concurrency-gate.js";

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn() },
}));

afterEach(() => {
  resetConcurrencyGateForTests();
});

describe("subagent-concurrency-gate", () => {
  it("should allow acquisition within limits", async () => {
    await acquireConcurrencySlot("agent-a");
    const stats = getConcurrencyStats();
    expect(stats.active).toBe(1);
    expect(stats.max).toBe(10);
    expect(stats.queued).toBe(0);
  });

  it("should track per-agent counts", async () => {
    await acquireConcurrencySlot("agent-a");
    await acquireConcurrencySlot("agent-b");
    const stats = getConcurrencyStats();
    expect(stats.active).toBe(2);
    expect(stats.activeByAgent).toEqual({ "agent-a": 1, "agent-b": 1 });
  });

  it("should release slots correctly", async () => {
    await acquireConcurrencySlot("agent-a");
    await acquireConcurrencySlot("agent-a");
    releaseConcurrencySlot("agent-a");
    const stats = getConcurrencyStats();
    expect(stats.active).toBe(1);
    expect(stats.activeByAgent["agent-a"]).toBe(1);
  });

  it("should remove agent from map when count reaches 0", async () => {
    await acquireConcurrencySlot("agent-a");
    releaseConcurrencySlot("agent-a");
    const stats = getConcurrencyStats();
    expect(stats.active).toBe(0);
    expect(stats.activeByAgent["agent-a"]).toBeUndefined();
  });

  it("should queue when max slots reached", async () => {
    vi.useFakeTimers();
    configureConcurrencyGate({ maxGlobalConcurrent: 2 });
    await acquireConcurrencySlot("agent-a");
    await acquireConcurrencySlot("agent-b");

    let resolved = false;
    const _promise = acquireConcurrencySlot("agent-c").then(() => {
      resolved = true;
    });

    expect(getConcurrencyStats().queued).toBe(1);
    expect(resolved).toBe(false);

    releaseConcurrencySlot("agent-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
    expect(getConcurrencyStats().active).toBe(2);
    vi.useRealTimers();
  });

  it("should enforce fair share across agents", async () => {
    vi.useFakeTimers();
    configureConcurrencyGate({ maxGlobalConcurrent: 2 });
    // Agent A takes 1 slot
    await acquireConcurrencySlot("agent-a");

    // Fair share with 1 agent = 2/1 = 2, so agent-a can still acquire
    await acquireConcurrencySlot("agent-a");
    expect(getConcurrencyStats().active).toBe(2);

    // Now at max. Both agent-a and agent-b queue.
    let agentAQueued = false;
    const _promiseA = acquireConcurrencySlot("agent-a").then(() => {
      agentAQueued = true;
    });

    let agentBQueued = false;
    const _promiseB = acquireConcurrencySlot("agent-b").then(() => {
      agentBQueued = true;
    });

    expect(getConcurrencyStats().queued).toBe(2);

    // Release one of agent-a's slots — agent-b should be preferred (under fair share)
    releaseConcurrencySlot("agent-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(agentBQueued).toBe(true);
    expect(agentAQueued).toBe(false);

    // Release agent-a's other slot — now agent-a can proceed
    releaseConcurrencySlot("agent-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(agentAQueued).toBe(true);
    vi.useRealTimers();
  });

  it("should configure max slots", () => {
    configureConcurrencyGate({ maxGlobalConcurrent: 5 });
    expect(getConcurrencyStats().max).toBe(5);
  });

  it("should not go below 0 on extra release", async () => {
    releaseConcurrencySlot("agent-a");
    expect(getConcurrencyStats().active).toBe(0);
  });

  it("should drain queue on release in FIFO order", async () => {
    vi.useFakeTimers();
    configureConcurrencyGate({ maxGlobalConcurrent: 1 });
    await acquireConcurrencySlot("agent-a");

    const order: string[] = [];
    const _p1 = acquireConcurrencySlot("agent-b").then(() => order.push("b"));
    const _p2 = acquireConcurrencySlot("agent-c").then(() => order.push("c"));

    releaseConcurrencySlot("agent-a");
    await vi.advanceTimersByTimeAsync(0);
    releaseConcurrencySlot("agent-b");
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual(["b", "c"]);
    vi.useRealTimers();
  });

  it("should independently timeout queued entries after 30s", async () => {
    vi.useFakeTimers();
    configureConcurrencyGate({ maxGlobalConcurrent: 1 });
    await acquireConcurrencySlot("agent-a");

    let rejected = false;
    let rejectionError = "";
    const promise = acquireConcurrencySlot("agent-b").catch((err: Error) => {
      rejected = true;
      rejectionError = err.message;
    });

    // Advance past the 30s timeout without releasing
    vi.advanceTimersByTime(31_000);
    await promise;
    expect(rejected).toBe(true);
    expect(rejectionError).toContain("timeout");
    expect(getConcurrencyStats().queued).toBe(0);
    vi.useRealTimers();
  });

  it("should reset state for tests", async () => {
    await acquireConcurrencySlot("agent-a");
    resetConcurrencyGateForTests();
    const stats = getConcurrencyStats();
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
  });
});
