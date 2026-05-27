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

  it("explicit runTimeoutSeconds wins over config default", async () => {
    applySubagentTimeoutDefault(900);
    const gateway = sessionsHarness.setupSessionsSpawnGatewayMock({});

    await spawnSubagent("call-2", { task: "hello", runTimeoutSeconds: 300 });

    expect(getSubagentTimeout(gateway.calls)).toBe(300);
  });
});
