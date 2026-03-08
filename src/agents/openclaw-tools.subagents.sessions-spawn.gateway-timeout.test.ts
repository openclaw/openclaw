import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

const callGatewayMock = getCallGatewayMock();

describe("sessions_spawn gateway timeout", () => {
  beforeEach(() => {
    resetSessionsSpawnConfigOverride();
    resetSubagentRegistryForTests();
    callGatewayMock.mockClear();
  });

  it("uses a 30s gateway timeout for spawn setup and dispatch calls", async () => {
    const requests: Array<{ method?: string; timeoutMs?: number }> = [];
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; timeoutMs?: number };
      requests.push(request);
      if (request.method === "agent") {
        return { runId: "run-timeout", status: "accepted" };
      }
      return { ok: true };
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    });

    const result = await tool.execute("call-timeout", {
      task: "do thing",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-timeout",
    });

    const spawnRequests = requests.filter(
      (request) => request.method === "sessions.patch" || request.method === "agent",
    );
    expect(spawnRequests.length).toBeGreaterThan(0);
    expect(spawnRequests.every((request) => request.timeoutMs === 30_000)).toBe(true);
  });

  it("uses a 30s gateway timeout for cleanup deletes after attachment setup fails", async () => {
    const requests: Array<{ method?: string; timeoutMs?: number }> = [];
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; timeoutMs?: number };
      requests.push(request);
      return { ok: true };
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    });

    const result = await tool.execute("call-timeout-cleanup", {
      task: "do thing",
      attachments: [{ name: "input.txt", content: "hello" }],
    });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error:
        "attachments are disabled for sessions_spawn (enable tools.sessions_spawn.attachments.enabled)",
    });

    const deleteRequests = requests.filter((request) => request.method === "sessions.delete");
    expect(deleteRequests.length).toBeGreaterThan(0);
    expect(deleteRequests.every((request) => request.timeoutMs === 30_000)).toBe(true);
  });
});
