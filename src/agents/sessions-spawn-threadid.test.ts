import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
    resolveGatewayPort: () => 18789,
  };
});

import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import {
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

describe("sessions_spawn requesterOrigin threading", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };

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
    const tool = createOpenClawTools({
      agentSessionKey: "main",
      agentChannel: "telegram",
      agentTo: "telegram:123",
      agentThreadId: 42,
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    await tool.execute("call", {
      task: "do thing",
      runTimeoutSeconds: 1,
    });

    const runs = listSubagentRunsForRequester("main");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.requesterOrigin).toMatchObject({
      channel: "telegram",
      to: "telegram:123",
      threadId: 42,
    });
  });

  it("stores requesterOrigin without threadId when none is provided", async () => {
    const tool = createOpenClawTools({
      agentSessionKey: "main",
      agentChannel: "telegram",
      agentTo: "telegram:123",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    await tool.execute("call", {
      task: "do thing",
      runTimeoutSeconds: 1,
    });

    const runs = listSubagentRunsForRequester("main");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.requesterOrigin?.threadId).toBeUndefined();
  });
});
