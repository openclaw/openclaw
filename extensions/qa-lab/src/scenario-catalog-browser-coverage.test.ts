import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";

describe("QA Control UI browser scenario catalog", () => {
  const coverageId = "control-ui.gateway-hosted-ui-control";

  it("loads the screenshot failure scenario as native Playwright coverage", () => {
    const scenario = readQaScenarioById("control-ui-browser-screenshot-body-cancel");

    expect(scenario.execution.kind).toBe("playwright");
    if (scenario.execution.kind !== "playwright") {
      throw new Error(`expected Playwright scenario, got ${scenario.execution.kind}`);
    }
    expect(scenario.execution.path).toBe("ui/src/e2e/browser-screenshot-body-cancel.e2e.test.ts");
    expect(scenario.execution.testNamePattern).toBe(
      "authenticates screenshot media and presents its HTTP failure",
    );
    expect(scenario.execution.flow).toBeUndefined();
    expect(scenario.coverage?.primary).not.toContain(coverageId);
    expect(scenario.coverage?.secondary).toContain(coverageId);
  });
});
