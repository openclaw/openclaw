import { describe, expect, it } from "vitest";
import { buildAlarmSummary } from "./alarm-summary.js";
import { createClaworksRuntime } from "./runtime.js";

describe("buildAlarmSummary", () => {
  it("returns empty summary when Alarm type is not loaded", async () => {
    const runtime = await createClaworksRuntime({
      robot: { name: "t", role: "monolith", port: 18800, host: "127.0.0.1" },
      data: { database_url: "sqlite://:memory:" },
      packs: { paths: [], installed: [] },
    });
    const summary = await buildAlarmSummary(runtime);
    expect(summary.total).toBe(0);
    expect(summary.by_severity).toEqual({});
  });
});
