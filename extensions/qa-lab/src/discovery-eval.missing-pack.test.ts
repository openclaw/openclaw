import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./scenario-catalog.js");
});

describe("qa discovery evaluation without packaged scenarios", () => {
  it("falls back to default refs when the QA scenario pack is unavailable", async () => {
    vi.doMock("./scenario-catalog.js", () => ({
      readQaScenarioExecutionConfig: () => {
        throw new Error("qa scenario pack not found: qa/scenarios/index.md");
      },
    }));

    const { reportsMissingDiscoveryFiles } = await import("./discovery-eval.js");

    const report = `
Worked
- Read all three requested files: repo/qa/scenarios/index.md, repo/extensions/qa-lab/src/suite.ts, and repo/docs/help/testing.md.
Failed
- None.
Blocked
- Runtime execution not attempted here.
Follow-up
- Run the live suite next.
`.trim();

    expect(reportsMissingDiscoveryFiles(report)).toBe(false);
  });
});
