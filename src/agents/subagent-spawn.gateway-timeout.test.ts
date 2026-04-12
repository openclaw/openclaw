import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";
import { installAcceptedSubagentGatewayMock } from "./test-helpers/subagent-gateway.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
}));

let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

function buildConfig(gatewayTimeoutMs?: number) {
  return createSubagentSpawnTestConfig(os.tmpdir(), {
    agents: {
      defaults: {
        workspace: os.tmpdir(),
        ...(typeof gatewayTimeoutMs === "number" ? { subagents: { gatewayTimeoutMs } } : {}),
      },
    },
  });
}

async function spawnOne() {
  return await spawnSubagentDirect(
    {
      task: "check timeout floor",
      model: "openai-codex/gpt-5.4",
    },
    {
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
      agentAccountId: "acct-1",
      agentTo: "user-1",
      workspaceDir: "/tmp/requester-workspace",
    },
  );
}

function gatewayCalls() {
  return hoisted.callGatewayMock.mock.calls.map((call) =>
    (call[0] ?? {}) as { method?: string; timeoutMs?: number },
  );
}

describe("subagent spawn gateway timeout floor", () => {
  beforeEach(async () => {
    ({ spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      loadConfig: () => hoisted.configOverride,
      resolveSubagentSpawnModelSelection: () => "openai-codex/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
    }));
    hoisted.callGatewayMock.mockReset();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    hoisted.configOverride = buildConfig();
  });

  it("uses default floors: 30s for agent and 20s for non-agent methods", async () => {
    const result = await spawnOne();
    expect(result.status).toBe("accepted");

    const calls = gatewayCalls();
    const agentCalls = calls.filter((entry) => entry.method === "agent");
    const nonAgentCalls = calls.filter((entry) => entry.method && entry.method !== "agent");

    expect(agentCalls.length).toBeGreaterThan(0);
    for (const entry of agentCalls) {
      expect(entry.timeoutMs).toBe(30_000);
    }

    expect(nonAgentCalls.length).toBeGreaterThan(0);
    for (const entry of nonAgentCalls) {
      expect(entry.timeoutMs).toBe(20_000);
    }
  });

  it("respects config override floor for all methods", async () => {
    hoisted.configOverride = buildConfig(45_000);

    const result = await spawnOne();
    expect(result.status).toBe("accepted");

    for (const entry of gatewayCalls()) {
      if (!entry.method) {
        continue;
      }
      expect(entry.timeoutMs).toBe(45_000);
    }
  });

  it("keeps caller timeout when it is higher than configured floor", async () => {
    hoisted.configOverride = buildConfig(5_000);

    const result = await spawnOne();
    expect(result.status).toBe("accepted");

    for (const entry of gatewayCalls()) {
      if (!entry.method) {
        continue;
      }
      expect(entry.timeoutMs).toBe(10_000);
    }
  });
});
