import { describe, expect, it, vi } from "vitest";
import { installCronHealthCheckSuggestion } from "./cron-health-check-install.js";

describe("installCronHealthCheckSuggestion", () => {
  it("creates a managed cron job when no existing health check job is present", async () => {
    const gatewayCall = vi
      .fn()
      .mockResolvedValueOnce({ jobs: [] })
      .mockResolvedValueOnce({ id: "job-new", name: "Harness health check" });

    const result = await installCronHealthCheckSuggestion({
      suggestion: {
        name: "Harness health check",
        cadence: "daily",
        schedule: { kind: "cron", expr: "0 9 * * *" },
        sessionTarget: "isolated",
        lightContext: true,
        focus: ["verification failures"],
        rationale: ["verification is failing"],
        message: "Review harness health.",
      },
      workspaceDir: "/tmp/workspace",
      sessionKey: "agent:main:telegram:dm:owner",
      model: "openai/gpt-5",
      gatewayCall: gatewayCall as never,
    });

    expect(result).toEqual({
      action: "created",
      jobId: "job-new",
      name: "Harness health check",
      scheduleExpr: "0 9 * * *",
      sessionTarget: "isolated",
      lightContext: true,
    });
    expect(gatewayCall).toHaveBeenCalledTimes(2);
    expect(gatewayCall.mock.calls[1]?.[0]).toMatchObject({
      method: "cron.add",
      params: {
        sessionKey: "agent:main:telegram:dm:owner",
        sessionTarget: "isolated",
        delivery: { mode: "announce", channel: "last" },
      },
    });
  });

  it("updates an existing managed cron job when one already exists for the workspace", async () => {
    const gatewayCall = vi
      .fn()
      .mockResolvedValueOnce({
        jobs: [
          {
            id: "job-existing",
            name: "Harness health check",
            description: "[openclaw:harness-health] workspace=/tmp/workspace",
          },
        ],
      })
      .mockResolvedValueOnce({ id: "job-existing", name: "Harness health check" });

    const result = await installCronHealthCheckSuggestion({
      suggestion: {
        name: "Harness health check",
        cadence: "weekly",
        schedule: { kind: "cron", expr: "0 9 * * 1" },
        sessionTarget: "isolated",
        lightContext: true,
        focus: ["prompt cost"],
        rationale: ["tool schemas are large"],
        message: "Review harness health.",
      },
      workspaceDir: "/tmp/workspace",
      gatewayCall: gatewayCall as never,
    });

    expect(result.action).toBe("updated");
    expect(gatewayCall).toHaveBeenCalledTimes(2);
    expect(gatewayCall.mock.calls[1]?.[0]).toMatchObject({
      method: "cron.update",
      params: {
        id: "job-existing",
      },
    });
  });
});
