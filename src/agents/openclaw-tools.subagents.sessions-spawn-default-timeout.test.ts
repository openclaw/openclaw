import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import * as sessionsHarness from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

const MAIN_SESSION_KEY = "agent:test:main";

function applySubagentTimeoutDefault(seconds: number) {
  sessionsHarness.setSessionsSpawnConfigOverride({
    session: { mainKey: "main", scope: "per-sender" },
    agents: { defaults: { subagents: { runTimeoutSeconds: seconds } } },
  });
}

function getSubagentTimeout(
  calls: Array<{ method?: string; params?: unknown }>,
): number | undefined {
  for (const call of calls) {
    if (call.method !== "agent") {
      continue;
    }
    const params = call.params as { lane?: string; timeout?: number } | undefined;
    if (params?.lane === "subagent") {
      return params.timeout;
    }
  }
  return undefined;
}

async function spawnSubagent(callId: string, payload: Record<string, unknown>) {
  const tool = await sessionsHarness.getSessionsSpawnTool({ agentSessionKey: MAIN_SESSION_KEY });
  const result = await tool.execute(callId, payload);
  expect(result.details).toMatchObject({ status: "accepted" });
}

describe("sessions_spawn default runTimeoutSeconds", () => {
  beforeEach(() => {
    sessionsHarness.resetSessionsSpawnConfigOverride();
    resetSubagentRegistryForTests();
    sessionsHarness.getCallGatewayMock().mockClear();
  });

  it("uses config default when agent omits runTimeoutSeconds", async () => {
    applySubagentTimeoutDefault(900);
    const gateway = sessionsHarness.setupSessionsSpawnGatewayMock({});

    await spawnSubagent("call-1", { task: "hello" });

    expect(getSubagentTimeout(gateway.calls)).toBe(900);
  });

  it("explicit runTimeoutSeconds can increase timeout above config default", async () => {
    applySubagentTimeoutDefault(300);
    const gateway = sessionsHarness.setupSessionsSpawnGatewayMock({});

    await spawnSubagent("call-2", { task: "hello", runTimeoutSeconds: 900 });

    expect(getSubagentTimeout(gateway.calls)).toBe(900);
  });

  it("config default acts as floor when agent provides lower runTimeoutSeconds", async () => {
    applySubagentTimeoutDefault(300);
    const gateway = sessionsHarness.setupSessionsSpawnGatewayMock({});

    await spawnSubagent("call-3", { task: "hello", runTimeoutSeconds: 60 });

    // Config default (300) is enforced as minimum, agent's 60 is rejected
    expect(getSubagentTimeout(gateway.calls)).toBe(300);
  });

  it("config default prevents model from decreasing timeout on retries", async () => {
    applySubagentTimeoutDefault(300);
    const gateway = sessionsHarness.setupSessionsSpawnGatewayMock({});

    // Simulate model decreasing timeout across retries (60 → 45 → 20)
    await spawnSubagent("call-4a", { task: "hello", runTimeoutSeconds: 60 });
    await spawnSubagent("call-4b", { task: "hello", runTimeoutSeconds: 45 });
    await spawnSubagent("call-4c", { task: "hello", runTimeoutSeconds: 20 });

    const calls = gateway.calls;
    // All three spawns should use config default (300) as floor
    expect(getSubagentTimeout(calls)).toBe(300);
  });
});
