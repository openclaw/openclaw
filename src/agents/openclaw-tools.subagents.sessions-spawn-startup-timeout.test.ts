import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
  setSessionsSpawnConfigOverride,
  setupSessionsSpawnGatewayMock,
  type GatewayRequest,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

const MAIN_SESSION_KEY = "agent:test:main";

function configureDefaults(subagents: Record<string, unknown>) {
  setSessionsSpawnConfigOverride({
    session: { mainKey: "main", scope: "per-sender" },
    agents: { defaults: { subagents } },
  });
}

function findSubagentStartupCall(
  calls: Array<GatewayRequest>,
): (GatewayRequest & { timeoutMs?: number }) | undefined {
  return calls.find((entry) => {
    if (entry.method !== "agent") {
      return false;
    }
    const params = entry.params as { lane?: string } | undefined;
    return params?.lane === "subagent";
  }) as (GatewayRequest & { timeoutMs?: number }) | undefined;
}

function findSessionsPatchCall(
  calls: Array<GatewayRequest>,
): (GatewayRequest & { timeoutMs?: number }) | undefined {
  return calls.find((entry) => entry.method === "sessions.patch") as
    | (GatewayRequest & { timeoutMs?: number })
    | undefined;
}

function findSessionsDeleteCall(
  calls: Array<GatewayRequest>,
): (GatewayRequest & { timeoutMs?: number }) | undefined {
  return calls.find((entry) => entry.method === "sessions.delete") as
    | (GatewayRequest & { timeoutMs?: number })
    | undefined;
}

describe("sessions_spawn subagent startup wait timeout", () => {
  beforeEach(() => {
    resetSessionsSpawnConfigOverride();
    resetSubagentRegistryForTests();
    getCallGatewayMock().mockClear();
  });

  it("falls back to 60s startup wait patience when config key is absent", async () => {
    configureDefaults({ maxConcurrent: 8 });
    const gateway = setupSessionsSpawnGatewayMock({});
    const tool = await getSessionsSpawnTool({ agentSessionKey: MAIN_SESSION_KEY });

    const result = await tool.execute("call-startup-timeout-default", { task: "hello" });

    expect(result.details).toMatchObject({ status: "accepted" });
    expect(findSubagentStartupCall(gateway.calls)?.timeoutMs).toBe(60_000);
  });

  it("honors configured startupWaitTimeoutMs for pre-launch setup and the primary startup RPC", async () => {
    configureDefaults({ maxConcurrent: 8, startupWaitTimeoutMs: 45_000 });
    const gateway = setupSessionsSpawnGatewayMock({});
    const tool = await getSessionsSpawnTool({ agentSessionKey: MAIN_SESSION_KEY });

    const result = await tool.execute("call-startup-timeout-configured", { task: "hello" });

    expect(result.details).toMatchObject({ status: "accepted" });
    expect(findSessionsPatchCall(gateway.calls)?.timeoutMs).toBe(45_000);
    expect(findSubagentStartupCall(gateway.calls)?.timeoutMs).toBe(45_000);
  });

  it("keeps cleanup-path waits on their short budget when startup fails", async () => {
    configureDefaults({ maxConcurrent: 8, startupWaitTimeoutMs: 45_000 });
    const calls: Array<GatewayRequest> = [];
    getCallGatewayMock().mockImplementation(async (request: GatewayRequest) => {
      calls.push(request);
      if (request.method === "sessions.patch") {
        return { ok: true };
      }
      if (request.method === "agent") {
        throw new Error("spawn startup failed");
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });
    const tool = await getSessionsSpawnTool({ agentSessionKey: MAIN_SESSION_KEY });

    const result = await tool.execute("call-startup-timeout-cleanup", { task: "hello" });

    expect(result.details).toMatchObject({
      status: "error",
      error: "spawn startup failed",
    });
    expect(findSubagentStartupCall(calls)?.timeoutMs).toBe(45_000);
    expect(findSessionsDeleteCall(calls)?.timeoutMs).toBe(10_000);
  });
});
