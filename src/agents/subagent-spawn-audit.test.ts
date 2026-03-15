import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureSpawnRateAlert,
  getSpawnRate,
  getSpawnSummary,
  querySpawnHistory,
  recordSpawn,
  resetSpawnAuditForTests,
  setSpawnAlertCallback,
} from "./subagent-spawn-audit.js";

const mockLog = vi.fn();
vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: (...args: unknown[]) => mockLog(...args) },
}));

beforeEach(() => {
  resetSpawnAuditForTests();
  mockLog.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("subagent-spawn-audit", () => {
  it("should record spawns", () => {
    recordSpawn({ agentId: "a", runId: "r1", childSessionKey: "s1" });
    expect(querySpawnHistory()).toHaveLength(1);
  });

  it("should track per-agent spawn rate", () => {
    recordSpawn({ agentId: "a", runId: "r1", childSessionKey: "s1" });
    recordSpawn({ agentId: "a", runId: "r2", childSessionKey: "s2" });
    recordSpawn({ agentId: "b", runId: "r3", childSessionKey: "s3" });
    expect(getSpawnRate("a")).toBe(2);
    expect(getSpawnRate("b")).toBe(1);
  });

  it("should trigger alert when threshold exceeded", () => {
    configureSpawnRateAlert({ threshold: 2 });
    recordSpawn({ agentId: "a", runId: "r1", childSessionKey: "s1" });
    recordSpawn({ agentId: "a", runId: "r2", childSessionKey: "s2" });
    expect(mockLog).not.toHaveBeenCalledWith(expect.stringContaining("RATE ALERT"));
    recordSpawn({ agentId: "a", runId: "r3", childSessionKey: "s3" });
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("RATE ALERT"));
  });

  it("should call alert callback", () => {
    configureSpawnRateAlert({ threshold: 1 });
    const cb = vi.fn();
    setSpawnAlertCallback(cb);
    recordSpawn({ agentId: "a", runId: "r1", childSessionKey: "s1" });
    recordSpawn({ agentId: "a", runId: "r2", childSessionKey: "s2" });
    expect(cb).toHaveBeenCalledWith(expect.stringContaining("RATE ALERT"), "a");
  });

  it("should not alert for different agents below threshold", () => {
    configureSpawnRateAlert({ threshold: 2 });
    recordSpawn({ agentId: "a", runId: "r1", childSessionKey: "s1" });
    recordSpawn({ agentId: "b", runId: "r2", childSessionKey: "s2" });
    recordSpawn({ agentId: "c", runId: "r3", childSessionKey: "s3" });
    expect(mockLog).not.toHaveBeenCalledWith(expect.stringContaining("RATE ALERT"));
  });

  it("should prune old events outside window", () => {
    recordSpawn({ agentId: "a", runId: "r1", childSessionKey: "s1" });
    vi.advanceTimersByTime(70_000); // past 60s window
    expect(getSpawnRate("a")).toBe(0);
  });

  it("should query by agentId", () => {
    recordSpawn({ agentId: "a", runId: "r1", childSessionKey: "s1" });
    recordSpawn({ agentId: "b", runId: "r2", childSessionKey: "s2" });
    const results = querySpawnHistory({ agentId: "a" });
    expect(results).toHaveLength(1);
    expect(results[0].agentId).toBe("a");
  });

  it("should query with limit", () => {
    for (let i = 0; i < 10; i++) {
      recordSpawn({ agentId: "a", runId: `r${i}`, childSessionKey: `s${i}` });
    }
    expect(querySpawnHistory({ limit: 3 })).toHaveLength(3);
  });

  it("should query with custom window", () => {
    recordSpawn({ agentId: "a", runId: "r1", childSessionKey: "s1" });
    vi.advanceTimersByTime(30_000);
    recordSpawn({ agentId: "a", runId: "r2", childSessionKey: "s2" });
    const results = querySpawnHistory({ windowMs: 20_000 });
    expect(results).toHaveLength(1);
  });

  it("should provide spawn summary", () => {
    recordSpawn({ agentId: "a", runId: "r1", childSessionKey: "s1" });
    recordSpawn({ agentId: "a", runId: "r2", childSessionKey: "s2" });
    recordSpawn({ agentId: "b", runId: "r3", childSessionKey: "s3" });
    const summary = getSpawnSummary();
    expect(summary["a"].perMinute).toBe(2);
    expect(summary["b"].perMinute).toBe(1);
  });

  it("should reset for tests", () => {
    recordSpawn({ agentId: "a", runId: "r1", childSessionKey: "s1" });
    resetSpawnAuditForTests();
    expect(querySpawnHistory()).toHaveLength(0);
  });

  it("should include label in history", () => {
    recordSpawn({ agentId: "a", runId: "r1", childSessionKey: "s1", label: "my-task" });
    const results = querySpawnHistory();
    expect(results[0].label).toBe("my-task");
  });
});
