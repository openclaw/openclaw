import { describe, expect, it, vi } from "vitest";
import { installDocGardeningSuggestion } from "./doc-gardening-install.js";

describe("installDocGardeningSuggestion", () => {
  it("creates a managed doc gardening cron job when none exists", async () => {
    const gatewayCall = vi
      .fn()
      .mockResolvedValueOnce({ jobs: [] })
      .mockResolvedValueOnce({ id: "job-docs", name: "Doc gardening" });

    const result = await installDocGardeningSuggestion({
      suggestion: {
        name: "Doc gardening",
        cadence: "daily",
        schedule: { kind: "cron", expr: "15 9 * * *" },
        sessionTarget: "isolated",
        lightContext: true,
        issues: [],
        focus: ["stale docs"],
        rationale: ["2 docs are stale"],
        message: "Review repo knowledge health.",
      },
      workspaceDir: "/tmp/workspace",
      sessionKey: "agent:main:telegram:dm:owner",
      model: "openai/gpt-5",
      gatewayCall: gatewayCall as never,
    });

    expect(result).toEqual({
      action: "created",
      jobId: "job-docs",
      name: "Doc gardening",
      scheduleExpr: "15 9 * * *",
      sessionTarget: "isolated",
      lightContext: true,
    });
    expect(gatewayCall.mock.calls[1]?.[0]).toMatchObject({
      method: "cron.add",
      params: {
        sessionKey: "agent:main:telegram:dm:owner",
        sessionTarget: "isolated",
      },
    });
  });

  it("updates an existing managed doc gardening cron job for the workspace", async () => {
    const gatewayCall = vi
      .fn()
      .mockResolvedValueOnce({
        jobs: [
          {
            id: "job-existing",
            description: "[openclaw:doc-garden] workspace=/tmp/workspace",
          },
        ],
      })
      .mockResolvedValueOnce({ id: "job-existing", name: "Doc gardening" });

    const result = await installDocGardeningSuggestion({
      suggestion: {
        name: "Doc gardening",
        cadence: "weekly",
        schedule: { kind: "cron", expr: "15 9 * * 1" },
        sessionTarget: "isolated",
        lightContext: true,
        issues: [],
        focus: ["docs freshness review"],
        rationale: ["periodic cleanup keeps docs from drifting"],
        message: "Review repo knowledge health.",
      },
      workspaceDir: "/tmp/workspace",
      gatewayCall: gatewayCall as never,
    });

    expect(result.action).toBe("updated");
    expect(gatewayCall.mock.calls[1]?.[0]).toMatchObject({
      method: "cron.update",
      params: {
        id: "job-existing",
      },
    });
  });
});
