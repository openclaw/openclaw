import { describe, expect, it } from "vitest";
import {
  createCrabboxProvisionTelemetry,
  createCrabboxWorkerStageObserver,
  type CrabboxProvisionStageEvent,
} from "./crabbox-worker-provision-telemetry.js";

describe("Crabbox provisioning telemetry", () => {
  it("records terminal timing and a safe error class without error content", async () => {
    const events: CrabboxProvisionStageEvent[] = [];
    let time = 100;
    const telemetry = createCrabboxProvisionTelemetry(
      "operation-1",
      "cbx_1",
      (event) => events.push(event),
      () => time,
    );
    await expect(
      telemetry.stage("ssh-ready", async () => {
        time += 17;
        throw new Error("Bearer secret-value");
      }),
    ).rejects.toThrow("Bearer secret-value");
    expect(events).toEqual([
      {
        leaseId: "cbx_1",
        operationId: "operation-1",
        stage: "ssh-ready",
        elapsedMs: 0,
        totalElapsedMs: 0,
        outcome: "started",
      },
      {
        leaseId: "cbx_1",
        operationId: "operation-1",
        stage: "ssh-ready",
        elapsedMs: 17,
        totalElapsedMs: 17,
        outcome: "failed",
        errorCode: "Error",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret-value");
  });

  it("forwards only exact lease milestones from streamed command output", () => {
    const events: CrabboxProvisionStageEvent[] = [];
    const observe = createCrabboxWorkerStageObserver("cbx_1", "operation-1", (event) =>
      events.push(event),
    );
    const marker =
      'CRABBOX_WORKER_STAGE:{"leaseId":"cbx_1","stage":"installation","elapsedMs":23,"totalElapsedMs":71,"outcome":"completed"}\n';
    observe(Buffer.from(marker.slice(0, 38)), "stderr");
    observe(Buffer.from(marker.slice(38)), "stderr");
    observe(Buffer.from(marker.replace("cbx_1", "cbx_other")), "stderr");
    observe(Buffer.from(marker.replace("installation", "secret-value")), "stderr");
    observe(Buffer.from("Bearer secret-value\n"), "stderr");
    expect(events).toEqual([
      {
        leaseId: "cbx_1",
        operationId: "operation-1",
        stage: "worker-installation",
        elapsedMs: 23,
        totalElapsedMs: 71,
        outcome: "completed",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret-value");
  });
});
