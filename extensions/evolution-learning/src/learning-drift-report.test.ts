import { describe, expect, it } from "vitest";
import { buildLearningDriftReport } from "./learning-drift-report.js";

describe("learning drift report", () => {
  it("summarizes timeout, fallback, rollback, adoption, and failure rates", () => {
    const report = buildLearningDriftReport({
      generatedAt: "2026-05-22T00:00:00.000Z",
      successPatterns: [
        {
          status: "success",
          summary: "normal pass",
          tags: ["controlled-task-runner"],
          adopted_by: "controlled-task-runner",
        },
        {
          status: "success",
          summary: "fallback recovered",
          tags: ["fallback"],
          adoptedBy: "mar-judge",
        },
      ],
      failurePatterns: [
        {
          status: "failure",
          summary: "timeout while running",
          tags: ["timeout"],
        },
        {
          status: "rolled_back",
          summary: "rollback after drift",
          tags: ["rollback"],
          rollback_pointer: { trace_id: "trace-1" },
        },
      ],
    });

    expect(report).toEqual({
      schemaVersion: 1,
      generatedAt: "2026-05-22T00:00:00.000Z",
      totals: {
        total: 4,
        success: 2,
        failure: 2,
        timeout: 1,
        fallback: 1,
        rollback: 1,
        adopted: 2,
      },
      rates: {
        failureRate: 0.5,
        timeoutRate: 0.25,
        fallbackRate: 0.25,
        rollbackRate: 0.25,
        adoptionRate: 0.5,
      },
    });
  });
});
