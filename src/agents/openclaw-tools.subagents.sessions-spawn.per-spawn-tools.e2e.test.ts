import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

const callGatewayMock = getCallGatewayMock();

describe("openclaw-tools: subagents (sessions_spawn per-spawn tools)", () => {
  function mockAcceptedSpawn() {
    const patchCalls: Array<Record<string, unknown>> = [];
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.patch") {
        patchCalls.push(request.params ?? {});
        return {};
      }
      if (request.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
      }
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    return patchCalls;
  }

  beforeEach(() => {
    resetSessionsSpawnConfigOverride();
    resetSubagentRegistryForTests();
    callGatewayMock.mockClear();
  });

  it("passes per-spawn tools.allow through sessions.patch", async () => {
    const patchCalls = mockAcceptedSpawn();

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });
    const result = await tool.execute("call-allow", {
      task: "do thing",
      tools: { allow: ["exec", "read"] },
    });

    expect(result.details).toMatchObject({ status: "accepted" });
    const depthPatch = patchCalls.find((p) => "spawnDepth" in p);
    expect(depthPatch).toBeDefined();
    expect(depthPatch!.spawnToolPolicy).toEqual({ allow: ["exec", "read"] });
  });

  it("passes per-spawn tools.deny through sessions.patch", async () => {
    const patchCalls = mockAcceptedSpawn();

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });
    const result = await tool.execute("call-deny", {
      task: "do thing",
      tools: { deny: ["browser"] },
    });

    expect(result.details).toMatchObject({ status: "accepted" });
    const depthPatch = patchCalls.find((p) => "spawnDepth" in p);
    expect(depthPatch!.spawnToolPolicy).toEqual({ deny: ["browser"] });
  });

  it("passes both allow and deny through sessions.patch", async () => {
    const patchCalls = mockAcceptedSpawn();

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });
    const result = await tool.execute("call-both", {
      task: "do thing",
      tools: { allow: ["exec"], deny: ["browser"] },
    });

    expect(result.details).toMatchObject({ status: "accepted" });
    const depthPatch = patchCalls.find((p) => "spawnDepth" in p);
    expect(depthPatch!.spawnToolPolicy).toEqual({ allow: ["exec"], deny: ["browser"] });
  });

  it("omits spawnToolPolicy when tools param is not provided", async () => {
    const patchCalls = mockAcceptedSpawn();

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });
    const result = await tool.execute("call-no-tools", {
      task: "do thing",
    });

    expect(result.details).toMatchObject({ status: "accepted" });
    const depthPatch = patchCalls.find((p) => "spawnDepth" in p);
    expect(depthPatch).toBeDefined();
    expect(depthPatch!.spawnToolPolicy).toBeUndefined();
  });

  it("omits spawnToolPolicy when tools param has empty arrays", async () => {
    const patchCalls = mockAcceptedSpawn();

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });
    const result = await tool.execute("call-empty", {
      task: "do thing",
      tools: {},
    });

    expect(result.details).toMatchObject({ status: "accepted" });
    const depthPatch = patchCalls.find((p) => "spawnDepth" in p);
    expect(depthPatch!.spawnToolPolicy).toBeUndefined();
  });

  it("per-spawn allow overrides global subagent tools.allow", async () => {
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      tools: {
        subagents: {
          tools: {
            allow: ["exec", "read", "write"],
          },
        },
      },
    });
    const patchCalls = mockAcceptedSpawn();

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });
    const result = await tool.execute("call-override", {
      task: "do thing",
      tools: { allow: ["exec"] },
    });

    expect(result.details).toMatchObject({ status: "accepted" });
    const depthPatch = patchCalls.find((p) => "spawnDepth" in p);
    expect(depthPatch!.spawnToolPolicy).toEqual({ allow: ["exec"] });
  });
});
