import { beforeEach, describe, expect, it } from "vitest";
import {
  addSubagentRunForTests,
  countActiveSubagentRuns,
  resetSubagentRegistryForTests,
  type SubagentRunRecord,
} from "./subagent-registry.js";

describe("subagent registry concurrency", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
  });

  it("exports countActiveSubagentRuns function", () => {
    expect(typeof countActiveSubagentRuns).toBe("function");
  });

  it("returns 0 when no subagents are running", () => {
    expect(countActiveSubagentRuns()).toBe(0);
  });

  it("counts only active (not ended) subagent runs", () => {
    // Add an active run (no endedAt)
    const activeRun: SubagentRunRecord = {
      runId: "run-1",
      childSessionKey: "agent:main:subagent:1",
      requesterSessionKey: "agent:main:discord:channel:123",
      requesterDisplayKey: "discord:channel:123",
      task: "Test task 1",
      cleanup: "keep",
      createdAt: Date.now(),
      startedAt: Date.now(),
    };
    addSubagentRunForTests(activeRun);

    expect(countActiveSubagentRuns()).toBe(1);

    // Add another active run
    const activeRun2: SubagentRunRecord = {
      runId: "run-2",
      childSessionKey: "agent:main:subagent:2",
      requesterSessionKey: "agent:main:discord:channel:123",
      requesterDisplayKey: "discord:channel:123",
      task: "Test task 2",
      cleanup: "keep",
      createdAt: Date.now(),
      startedAt: Date.now(),
    };
    addSubagentRunForTests(activeRun2);

    expect(countActiveSubagentRuns()).toBe(2);

    // Add a completed run (has endedAt)
    const completedRun: SubagentRunRecord = {
      runId: "run-3",
      childSessionKey: "agent:main:subagent:3",
      requesterSessionKey: "agent:main:discord:channel:123",
      requesterDisplayKey: "discord:channel:123",
      task: "Test task 3",
      cleanup: "keep",
      createdAt: Date.now() - 10000,
      startedAt: Date.now() - 10000,
      endedAt: Date.now() - 5000, // Completed
      outcome: { status: "ok" },
    };
    addSubagentRunForTests(completedRun);

    // Should still be 2 (completed run not counted)
    expect(countActiveSubagentRuns()).toBe(2);
  });
});
