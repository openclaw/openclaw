import { describe, expect, it } from "vitest";
import { detectRenderIncidents } from "./detection.js";

describe("render-monitor detection", () => {
  it("emits deploy_failed when latest deploy status failed", async () => {
    const incidents = await detectRenderIncidents({
      service: { serviceId: "srv-1" },
      snapshot: {
        serviceId: "srv-1",
        raw: {},
        status: "active",
        healthCheckState: "passing",
        latestDeploy: { id: "d-1", status: "failed" },
      },
      httpProbeEnabled: false,
      httpProbeTimeoutMs: 1000,
      consecutiveServiceErrorStreakCount: 0,
      nowMs: Date.now(),
    });

    expect(incidents.map((i) => i.incidentType)).toContain("deploy_failed");
  });

  it("emits service_error and crash_repeated when consecutive streak >= 3", async () => {
    const incidents = await detectRenderIncidents({
      service: { serviceId: "srv-2" },
      snapshot: {
        serviceId: "srv-2",
        raw: {},
        status: "error",
        healthCheckState: "passing",
        latestDeploy: { id: "d-2", status: "succeeded" },
      },
      httpProbeEnabled: false,
      httpProbeTimeoutMs: 1000,
      consecutiveServiceErrorStreakCount: 3,
      nowMs: Date.now(),
    });

    const types = incidents.map((i) => i.incidentType);
    expect(types).toContain("service_error");
    expect(types).toContain("crash_repeated");
  });
});

