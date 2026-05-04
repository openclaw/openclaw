import { describe, expect, it, vi } from "vitest";
import {
  runCoordinationAuthorizationProofLauncherRuntime,
  validateAuthorizationProofLauncherRuntimeInput,
} from "./authorization-proof-launcher-runtime.js";
import * as launcherModule from "./authorization-proof-launcher.js";

describe("runCoordinationAuthorizationProofLauncherRuntime", () => {
  it("refuses missing proofAttemptId", () => {
    expect(() =>
      validateAuthorizationProofLauncherRuntimeInput({
        authorizationPath: "/tmp/auth.json",
        jobPath: "/tmp/job.json",
      }),
    ).toThrow(/proofAttemptId is required/);
  });

  it("refuses missing authorizationPath", () => {
    expect(() =>
      validateAuthorizationProofLauncherRuntimeInput({
        jobPath: "/tmp/job.json",
        proofAttemptId: "attempt-1",
      }),
    ).toThrow(/authorizationPath is required/);
  });

  it("refuses missing jobPath", () => {
    expect(() =>
      validateAuthorizationProofLauncherRuntimeInput({
        authorizationPath: "/tmp/auth.json",
        proofAttemptId: "attempt-1",
      }),
    ).toThrow(/jobPath is required/);
  });

  it("passes through to the approved bounded launcher without using installed dist", async () => {
    const spy = vi
      .spyOn(launcherModule, "runCoordinationAuthorizationProofLauncher")
      .mockResolvedValue({
        loopResult: { status: "pass" },
        finalDebrief: { status: "ready_for_live_proof" },
        finalDebriefWrite: { wrote: true },
        watchdogRuns: [],
      } as never);

    await runCoordinationAuthorizationProofLauncherRuntime({
      authorizationPath: "/tmp/auth.json",
      jobPath: "/tmp/job.json",
      proofAttemptId: "attempt-1",
      actualPercentCompleteOnReady: 82,
    });

    expect(spy).toHaveBeenCalledWith({
      authorizationPath: "/tmp/auth.json",
      jobPath: "/tmp/job.json",
      proofAttemptId: "attempt-1",
      actualPercentCompleteOnReady: 82,
    });
  });

  it("supports mocked mode that reaches the approved bounded path without live safe-probe", async () => {
    const spy = vi
      .spyOn(launcherModule, "runCoordinationAuthorizationProofLauncher")
      .mockResolvedValue({
        loopResult: { status: "blocked" },
        finalDebrief: { status: "blocked" },
        finalDebriefWrite: { wrote: true },
        watchdogRuns: [],
      } as never);

    const beforeCalls = spy.mock.calls.length;
    await runCoordinationAuthorizationProofLauncherRuntime({
      authorizationPath: "/tmp/auth.json",
      jobPath: "/tmp/job.json",
      proofAttemptId: "attempt-2",
    });

    expect(spy.mock.calls.length - beforeCalls).toBe(1);
  });

  it("does not construct raw agent-exec or dist fallback command strings", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        "/Users/corey-domidocs/src/openclaw-2026.4.21/src/agents/coordination/authorization-proof-launcher-runtime.ts",
        "utf8",
      ),
    );

    expect(source).not.toContain("dist/");
    expect(source).not.toContain("agent-exec ");
    expect(source).not.toContain("child_process");
  });
});
