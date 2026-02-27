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
const SDR_KEY = "agent:main:subagent:sdr";
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
    // SDR is a leaf subagent (depth 1 = default maxSpawnDepth 1), spawnedBy main
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [SDR_KEY]: {
          sessionId: "sdr-session",
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
    const tool = createSubagentsTool({ agentSessionKey: SDR_KEY });
    const result = await tool.execute("call-list", { action: "list" });

    expect(result.details).toMatchObject({
      status: "ok",
      // Must be SDR's own key — NOT MAIN_KEY via spawnedBy
      requesterSessionKey: SDR_KEY,
      callerSessionKey: SDR_KEY,
      callerIsSubagent: true,
    });
  });

  it("list: leaf sees no runs (it has no children), not parent's runs", async () => {
    // Register a run under MAIN — SDR must not see it
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

    const tool = createSubagentsTool({ agentSessionKey: SDR_KEY });
    const result = await tool.execute("call-list-isolation", { action: "list" });

    expect(result.details).toMatchObject({
      status: "ok",
      total: 0,
      active: [],
      recent: [],
    });
  });

  it("orchestrator subagent (depth < maxSpawnDepth) still uses its own key and sees its children", async () => {
    // Raise the depth limit so SDR is now an orchestrator
    setSubagentsConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
        store: storePath,
      },
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
    });

    addSubagentRunForTests({
      runId: "ghostwriter-run",
      childSessionKey: "agent:main:subagent:ghostwriter",
      requesterSessionKey: SDR_KEY,
      requesterDisplayKey: "sdr",
      task: "rewrite message",
      cleanup: "keep",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });

    const tool = createSubagentsTool({ agentSessionKey: SDR_KEY });
    const result = await tool.execute("call-list-orchestrator", { action: "list" });

    expect(result.details).toMatchObject({
      status: "ok",
      requesterSessionKey: SDR_KEY,
      total: 1,
      active: expect.arrayContaining([expect.objectContaining({ runId: "ghostwriter-run" })]),
    });
  });
});
