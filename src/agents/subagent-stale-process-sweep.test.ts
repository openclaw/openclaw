import { describe, expect, it } from "vitest";
import { detectSubagentStaleProcessRisk } from "./subagent-stale-process-sweep.js";

describe("subagent stale-process sweep detector", () => {
  it("marks relevant child/test processes as STALE_PROCESS_RISK without killing them", () => {
    const result = detectSubagentStaleProcessRisk({
      childRunId: "run-wave5",
      childSessionKey: "agent:main:subagent:wave5",
      processes: [
        { pid: 100, command: "sleep 1000" },
        { pid: 101, childRunId: "run-wave5", command: "node scripts/run-vitest.mjs" },
        { pid: 102, command: "pnpm vitest src/agents/subagent-child-result-contract.test.ts" },
      ],
    });

    expect(result.status).toBe("STALE_PROCESS_RISK");
    expect(result.noRunningProcesses).toBe(false);
    expect(result.relevantProcessCount).toBe(2);
    expect(result.reasons).toContain("RELEVANT_CHILD_OR_TEST_PROCESS_STILL_RUNNING");
    expect(result.processes.map((process) => process.pid)).toEqual([101, 102]);
  });

  it("returns a clean marker when no relevant child/test process remains", () => {
    const result = detectSubagentStaleProcessRisk({
      childRunId: "run-wave5",
      childSessionKey: "agent:main:subagent:wave5",
      processes: [{ pid: 200, command: "sleep 1000" }],
    });

    expect(result.status).toBe("clean");
    expect(result.noRunningProcesses).toBe(true);
    expect(result.relevantProcessCount).toBe(0);
  });
});
