import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
  setSessionsSpawnConfigOverride,
  setupSessionsSpawnGatewayMock,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

const MAIN_SESSION_KEY = "agent:test:main";

function configureDefaultsWithoutTimeout() {
  setSessionsSpawnConfigOverride({
    session: { mainKey: "main", scope: "per-sender" },
    agents: { defaults: { subagents: { maxConcurrent: 8 } } },
  });
}

function readSpawnTimeout(calls: Array<{ method?: string; params?: unknown }>): number | undefined {
  const spawn = calls.find((entry) => {
    if (entry.method !== "agent") {
      return false;
    }
    const params = entry.params as { lane?: string } | undefined;
    return params?.lane === "subagent";
  });
  const params = spawn?.params as { timeout?: number } | undefined;
  return params?.timeout;
}

describe("sessions_spawn default runTimeoutSeconds (config absent)", () => {
  beforeEach(() => {
    resetSessionsSpawnConfigOverride();
    resetSubagentRegistryForTests();
    getCallGatewayMock().mockClear();
  });

  it("falls back to 0 (no timeout) when config key is absent", async () => {
    configureDefaultsWithoutTimeout();
    const gateway = setupSessionsSpawnGatewayMock({});
    const tool = await getSessionsSpawnTool({ agentSessionKey: MAIN_SESSION_KEY });

    const result = await tool.execute("call-1", { task: "hello" });
    expect(result.details).toMatchObject({ status: "accepted" });
    expect(readSpawnTimeout(gateway.calls)).toBe(0);
  });
});
