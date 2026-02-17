import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  callGatewayMock,
  setSubagentsConfigOverride,
} from "./openclaw-tools.subagents.test-harness.js";
import "./test-helpers/fast-core-tools.js";

let createOpenClawTools: (typeof import("./openclaw-tools.js"))["createOpenClawTools"];
let addSubagentRunForTests: (typeof import("./subagent-registry.js"))["addSubagentRunForTests"];
let listSubagentRunsForRequester: (typeof import("./subagent-registry.js"))["listSubagentRunsForRequester"];
let resetSubagentRegistryForTests: (typeof import("./subagent-registry.js"))["resetSubagentRegistryForTests"];

describe("openclaw-tools: subagents steer failure", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ createOpenClawTools } = await import("./openclaw-tools.js"));
    ({ addSubagentRunForTests, listSubagentRunsForRequester, resetSubagentRegistryForTests } =
      await import("./subagent-registry.js"));
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const storePath = path.join(
      os.tmpdir(),
      `openclaw-subagents-steer-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    setSubagentsConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
        store: storePath,
      },
    });
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
