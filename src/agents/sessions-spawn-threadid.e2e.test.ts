import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import {
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

describe("sessions_spawn requesterOrigin threading", () => {
  const spawnAndReadRequesterRun = async (opts?: { agentThreadId?: number }) => {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "telegram",
      agentTo: "telegram:123",
      ...(opts?.agentThreadId === undefined ? {} : { agentThreadId: opts.agentThreadId }),
    });
    const result = await tool.execute("call", {
      task: "do thing",
      runTimeoutSeconds: 1,
    });
    expect(result.details).toMatchObject({ status: "accepted", runId: "run-1" });

    const runs = listSubagentRunsForRequester("main");
    expect(runs).toHaveLength(1);
    return runs[0];
  };

  beforeEach(() => {
    const callGatewayMock = getCallGatewayMock();
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string };
      if (req.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1 };
      }
      // Prevent background announce flow by returning a non-terminal status.
      if (req.method === "agent.wait") {
        return { runId: "run-1", status: "running" };
      }
      return {};
    });
  });

  it("captures threadId in requesterOrigin", async () => {
    const run = await spawnAndReadRequesterRun({ agentThreadId: 42 });
    expect(run?.requesterOrigin).toMatchObject({
      channel: "telegram",
      to: "telegram:123",
      threadId: 42,
    });
  });

  it("stores requesterOrigin without threadId when none is provided", async () => {
    const run = await spawnAndReadRequesterRun();
    expect(run?.requesterOrigin?.threadId).toBeUndefined();
  });
});
