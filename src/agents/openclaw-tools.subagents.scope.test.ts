import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
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
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-subagents-scope-");
  let storePath = "";
  beforeEach(async () => {
    await resetSubagentRegistryForTests();
    resetSubagentsConfigOverride();
    callGatewayMock.mockReset();
    storePath = path.join(sessionDirs.make(), "sessions.sqlite");
    const config = { session: createPerSenderSessionConfig({ store: storePath }) };
    setSubagentsConfigOverride(config);
    setRuntimeConfigSnapshot(config);
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
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
    const store: Record<string, SessionEntry> = {
      [callerKey]: { sessionId: role, updatedAt: now, spawnedBy: "agent:main:main" },
    };
    for (const [index, run] of runs.entries()) {
      store[run.childSessionKey] = {
        sessionId: `session-${index}`,
        updatedAt: now,
        spawnedBy: run.requesterSessionKey,
      };
    }
    for (const [sessionKey, entry] of Object.entries(store)) {
      await replaceSessionEntry({ agentId: "main", sessionKey, storePath }, entry);
    }
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
