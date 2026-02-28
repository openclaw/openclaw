import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  callGatewayMock,
  setSubagentsConfigOverride,
} from "./openclaw-tools.subagents.test-harness.js";
import { addSubagentRunForTests, resetSubagentRegistryForTests } from "./subagent-registry.js";
import "./test-helpers/fast-core-tools.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";

/**
 * Tests for subagents tool leaf-subagent requester key routing.
 *
 * Bug (GitHub issue #24174): When a leaf subagent (depth === maxSpawnDepth)
 * calls the subagents tool, resolveRequesterKey walks up spawnedBy and returns
 * the parent session key as requesterSessionKey. This causes:
 *   - subagent announce to route to root parent instead of the immediate caller
 *   - leaf subagent can list/kill sibling runs it doesn't own (scope violation)
 *
 * Fix: leaf subagents should use their own callerSessionKey as requesterSessionKey.
 */

const MAIN_KEY = "agent:main:main";
const WORKER_KEY = "agent:main:subagent:worker";
const SIBLING_KEY = "agent:main:subagent:sibling";

describe("subagents tool: leaf subagent uses own session key as requesterSessionKey", () => {
  let storePath: string;

  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockClear();
    storePath = path.join(
      os.tmpdir(),
      `openclaw-subagents-leaf-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    // worker is a leaf subagent (depth 1 = default maxSpawnDepth 1), spawnedBy main
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [WORKER_KEY]: {
          sessionId: "worker-session",
          updatedAt: Date.now(),
          spawnedBy: MAIN_KEY,
        },
      }),
      "utf-8",
    );
    setSubagentsConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
        store: storePath,
      },
    });
  });

  it("list: requesterSessionKey is the leaf's own key, not its parent's", async () => {
    const tool = createSubagentsTool({ agentSessionKey: WORKER_KEY });
    const result = await tool.execute("call-list", { action: "list" });

    expect(result.details).toMatchObject({
      status: "ok",
      // Must be worker's own key — NOT MAIN_KEY via spawnedBy
      requesterSessionKey: WORKER_KEY,
      callerSessionKey: WORKER_KEY,
      callerIsSubagent: true,
    });
  });

  it("list: leaf sees no runs (it has no children), not parent's runs", async () => {
    // Register a run under MAIN — worker must not see it
    addSubagentRunForTests({
      runId: "parent-run",
      childSessionKey: SIBLING_KEY,
      requesterSessionKey: MAIN_KEY,
      requesterDisplayKey: "main",
      task: "sibling task",
      cleanup: "keep",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });

    const tool = createSubagentsTool({ agentSessionKey: WORKER_KEY });
    const result = await tool.execute("call-list-isolation", { action: "list" });

    expect(result.details).toMatchObject({
      status: "ok",
      total: 0,
      active: [],
      recent: [],
    });
  });

  it("orchestrator subagent (depth < maxSpawnDepth) still uses its own key and sees its children", async () => {
    // Raise the depth limit so worker is now an orchestrator
    setSubagentsConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
        store: storePath,
      },
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
    });

    addSubagentRunForTests({
      runId: "child-run",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: WORKER_KEY,
      requesterDisplayKey: "worker",
      task: "process item",
      cleanup: "keep",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });

    const tool = createSubagentsTool({ agentSessionKey: WORKER_KEY });
    const result = await tool.execute("call-list-orchestrator", { action: "list" });

    expect(result.details).toMatchObject({
      status: "ok",
      requesterSessionKey: WORKER_KEY,
      total: 1,
      active: expect.arrayContaining([expect.objectContaining({ runId: "child-run" })]),
    });
  });
});
