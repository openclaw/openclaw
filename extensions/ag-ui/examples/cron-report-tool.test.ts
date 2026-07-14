import { describe, it, expect } from "vitest";
import { cronReportToolFactory } from "./cron-report-tool.js";

describe("cronReportToolFactory", () => {
  it("returns null when sessionKey is missing", () => {
    expect(cronReportToolFactory({})).toBeNull();
    expect(cronReportToolFactory({ sessionKey: undefined })).toBeNull();
  });

  it("returns a tool with correct name and parameters", () => {
    const tool = cronReportToolFactory({ sessionKey: "test-session" });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("cron_report");
    expect(tool!.parameters.required).toContain("runs");
  });

  it("execute returns valid A2UI v0.9 JSON with 3 operations", async () => {
    const tool = cronReportToolFactory({ sessionKey: "test-session" })!;
    const runs = [
      {
        id: "run-1",
        startedAt: "Apr 5, 10:30 AM",
        duration: "2m 14s",
        model: "claude-sonnet-4-6",
        tokensUsed: "12,847",
        summary: "All checks passed.",
      },
    ];

    const result = await tool.execute("tc-1", { runs });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.a2ui_operations).toHaveLength(3);

    const [create, update, data] = parsed.a2ui_operations;
    expect(create.version).toBe("v0.9");
    expect(create.createSurface.surfaceId).toBe("cron-report");
    expect(update.updateComponents.surfaceId).toBe("cron-report");
    expect(update.updateComponents.components).toBeDefined();
    expect(data.updateDataModel.value.runs).toEqual(runs);
  });
});
