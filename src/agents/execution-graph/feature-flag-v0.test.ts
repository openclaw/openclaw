import { describe, expect, it } from "vitest";
import { isExecutionGraphRuntimeV0Enabled } from "./feature-flag-v0.js";

describe("isExecutionGraphRuntimeV0Enabled", () => {
  it("is disabled by default", () => {
    expect(isExecutionGraphRuntimeV0Enabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("enables only when OPENCLAW_EXECUTION_GRAPH_V0 is truthy", () => {
    expect(
      isExecutionGraphRuntimeV0Enabled({ OPENCLAW_EXECUTION_GRAPH_V0: "1" } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isExecutionGraphRuntimeV0Enabled({
        OPENCLAW_EXECUTION_GRAPH_V0: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("kill switch disables the runtime even when enabled", () => {
    expect(
      isExecutionGraphRuntimeV0Enabled({
        OPENCLAW_EXECUTION_GRAPH_V0: "1",
        OPENCLAW_EXECUTION_GRAPH_V0_DISABLE: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});
