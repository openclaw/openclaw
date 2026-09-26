import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupRuntimeToolFixtureTempRoots,
  mockToolRequests,
  runMockRuntimeToolFixture,
} from "../test/runtime-tool-fixture-helpers.js";

afterEach(cleanupRuntimeToolFixtureTempRoots);

describe("runtime tool fixture known harness gaps", () => {
  it.each([
    { phase: "unavailable tool", tools: [], requests: [] },
    { phase: "missing happy call", requests: [] },
    {
      phase: "missing happy output",
      requests: mockToolRequests({ omitHappyOutput: true }),
    },
    {
      phase: "failed happy output",
      requests: mockToolRequests({ happyOutput: "Error: unavailable" }),
    },
    {
      phase: "missing failure output",
      requests: mockToolRequests({ omitFailureOutput: true }),
    },
    {
      phase: "successful failure output",
      requests: mockToolRequests({ failureOutput: "README contents" }),
    },
  ])("preserves an explicit known harness gap for $phase", async ({ requests, ...fixture }) => {
    await expect(
      runMockRuntimeToolFixture({
        requests,
        tools: "tools" in fixture ? fixture.tools : undefined,
        config: { knownHarnessGap: { reason: "QA fixture unavailable", issue: "#80319" } },
      }),
    ).rejects.toMatchObject({
      name: "QaSuiteScenarioSkipError",
      message: [
        "known-harness-gap read: QA fixture unavailable",
        "tracking: #80319",
        "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:happy",
        "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:failure",
      ].join("\n"),
    });
  });
});
