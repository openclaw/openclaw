import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();

describe("runEmbeddedAttempt tool allowlist", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
  });

  it("passes OpenClaw-managed custom tool names to Pi's session allowlist", async () => {
    await createContextEngineAttemptRunner({
      sessionKey: "agent:qa:repo-contract",
      tempPaths,
      contextEngine: createContextEngineBootstrapAndAssemble(),
    });

    const options = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0] as
      | {
          customTools?: Array<{ name?: string }>;
          tools?: string[];
        }
      | undefined;
    expect(options?.customTools?.map((tool) => tool.name)).toContain("sessions_spawn");
    expect(options?.tools).toContain("sessions_spawn");
  });
});
