import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  callGatewayMock,
  resetSubagentsConfigOverride,
  setSubagentsConfigOverride,
} from "./openclaw-tools.subagents.test-harness.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import { createPerSenderSessionConfig } from "./test-helpers/session-config.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";

describe("subagents scope isolation", () => {
  let storePath = "";
  beforeEach(async () => {
    await resetSubagentRegistryForTests();
    resetSubagentsConfigOverride();
    callGatewayMock.mockReset();
    storePath = path.join(os.tmpdir(), `openclaw-subagents-scope-${randomUUID()}.json`);
    setSubagentsConfigOverride({ session: createPerSenderSessionConfig({ store: storePath }) });
  });

  it.each([
    { role: "leaf", ownChild: false },
    { role: "orchestrator", ownChild: true },
  ])("limits $role visibility to its own children", async ({ role, ownChild }) => {
    const callerKey = `agent:main:subagent:${role}`;
    const childKey = ownChild ? `${callerKey}:subagent:worker` : callerKey;
    const siblingKey = "agent:main:subagent:sibling";
    const runs = [
      { childSessionKey: childKey, requesterSessionKey: ownChild ? callerKey : "agent:main:main" },
      { childSessionKey: siblingKey, requesterSessionKey: "agent:main:main" },
    ];
    const now = Date.now();
    const store: Record<string, unknown> = {
      [callerKey]: { sessionId: role, updatedAt: now, spawnedBy: "agent:main:main" },
    };
    for (const [index, run] of runs.entries()) {
      store[run.childSessionKey] = {
        sessionId: `session-${index}`,
        updatedAt: now,
        spawnedBy: run.requesterSessionKey,
      };
    }
    fs.writeFileSync(storePath, JSON.stringify(store), "utf-8");
    for (const [index, run] of runs.entries()) {
      await addSubagentRunForTests({
        ...run,
        runId: `run-${index}`,
        requesterDisplayKey: run.requesterSessionKey,
        task: `task-${index}`,
        cleanup: "keep",
        createdAt: now - 30_000,
        startedAt: now - 30_000,
      });
    }
    const result = await createSubagentsTool({ agentSessionKey: callerKey }).execute("list", {
      action: "list",
    });
    expect(result.details).toMatchObject({
      status: "ok",
      requesterSessionKey: callerKey,
      callerSessionKey: callerKey,
      callerIsSubagent: true,
      total: ownChild ? 1 : 0,
      active: ownChild ? [expect.objectContaining({ sessionKey: childKey })] : [],
      recent: [],
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});
