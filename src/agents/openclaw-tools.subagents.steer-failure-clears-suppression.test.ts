import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  };
});

import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import {
  addSubagentRunForTests,
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

describe("openclaw-tools: subagents steer failure", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const storePath = path.join(
      os.tmpdir(),
      `openclaw-subagents-steer-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
        store: storePath,
      },
    };
    fs.writeFileSync(storePath, "{}", "utf-8");
  });

  it("restores announce behavior when steer replacement dispatch fails", async () => {
    addSubagentRunForTests({
      runId: "run-old",
      childSessionKey: "agent:main:subagent:worker",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do work",
      cleanup: "keep",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      if (request.method === "agent") {
        throw new Error("dispatch failed");
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "subagents");
    if (!tool) {
      throw new Error("missing subagents tool");
    }

    const result = await tool.execute("call-steer", {
      action: "steer",
      target: "1",
      message: "new direction",
    });

    expect(result.details).toMatchObject({
      status: "error",
      action: "steer",
      runId: expect.any(String),
      error: "dispatch failed",
    });

    const runs = listSubagentRunsForRequester("agent:main:main");
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe("run-old");
    expect(runs[0].suppressAnnounceReason).toBeUndefined();
  });
});
