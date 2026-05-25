import { describe, expect, it, vi } from "vitest";
import {
  buildSandboxSimulateVariables,
  createSandboxPlaybookTriggerRunner,
  runSandboxPlaybookSimulation,
} from "./sandbox-playbook-runner.js";

describe("buildSandboxSimulateVariables", () => {
  it("merges test_payload with sandbox flags", () => {
    expect(
      buildSandboxSimulateVariables({
        testPayload: { sensor_id: "line-1" },
        draftReview: true,
      }),
    ).toEqual({
      sensor_id: "line-1",
      _simulate: true,
      _sandbox: true,
      _draft_review: true,
    });
  });

  it("evolution regression omits _draft_review", () => {
    expect(buildSandboxSimulateVariables({ testPayload: { _sandbox: true } })).toEqual({
      _sandbox: true,
      _simulate: true,
    });
  });
});

describe("createSandboxPlaybookTriggerRunner", () => {
  it("passes merged variables to playbookEngine.trigger", async () => {
    const trigger = vi.fn(async (_pid, event, opts) => {
      expect(event).toEqual({ type: "sandbox.regression.pb_a" });
      expect(opts?.variables).toEqual({
        _sandbox: true,
        _simulate: true,
      });
      return { steps: [], status: "completed" as const };
    });

    const runner = createSandboxPlaybookTriggerRunner({ trigger });
    const result = await runner(
      "pb_a",
      { _sandbox: true },
      { type: "sandbox.regression.pb_a" },
      {},
    );

    expect(result.error).toBeUndefined();
    expect(trigger).toHaveBeenCalledOnce();
  });
});

describe("runSandboxPlaybookSimulation", () => {
  it("returns passed=false when trigger reports failed steps", async () => {
    const trigger = vi.fn(async () => ({
      steps: [{ stepId: "s1", status: "failed", error: "boom" }],
      status: "failed" as const,
      error: "boom",
    }));

    const result = await runSandboxPlaybookSimulation({ trigger }, "pb_bad", {
      testPayload: { _sandbox: true },
      triggerEventType: "sandbox.regression.pb_bad",
    });

    expect(result.passed).toBe(false);
    expect(result.status).toBe("error");
    expect(result.error).toBe("boom");
  });
});
