import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntry } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  callGatewayMock,
  resetSubagentsConfigOverride,
  setSubagentsConfigOverride,
} from "./openclaw-tools.subagents.test-harness.js";
import { addSubagentRunForTests, resetSubagentRegistryForTests } from "./subagent-registry.js";
import { createPerSenderSessionConfig } from "./test-helpers/session-config.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";

function writeStore(store: Record<string, SessionEntry>) {
  for (const [sessionKey, entry] of Object.entries(store)) {
    upsertSessionEntry({ agentId: "main", sessionKey, entry });
  }
}

async function seedLeafOwnedChildSession(leafKey = "agent:main:subagent:leaf") {
  const childKey = `${leafKey}:subagent:child`;
  writeStore({
    [leafKey]: {
      sessionId: "leaf-session",
      updatedAt: Date.now(),
      spawnedBy: "agent:main:main",
      subagentRole: "leaf",
      subagentControlScope: "none",
    },
    [childKey]: {
      sessionId: "child-session",
      updatedAt: Date.now(),
      spawnedBy: leafKey,
      subagentRole: "leaf",
      subagentControlScope: "none",
    },
  });

  addSubagentRunForTests({
    runId: "run-child",
    childSessionKey: childKey,
    controllerSessionKey: leafKey,
    requesterSessionKey: leafKey,
    requesterDisplayKey: leafKey,
    task: "impossible child",
    cleanup: "keep",
    createdAt: Date.now() - 30_000,
    startedAt: Date.now() - 30_000,
  });

  return {
    childKey,
    tool: createSubagentsTool({ agentSessionKey: leafKey }),
  };
}

async function expectLeafSubagentControlForbidden(params: {
  action: "kill" | "steer";
  callId: string;
  message?: string;
}) {
  const { childKey, tool } = await seedLeafOwnedChildSession();
  const result = await tool.execute(params.callId, {
    action: params.action,
    target: childKey,
    ...(params.message ? { message: params.message } : {}),
  });

  const details = result.details as { status?: string; error?: string };
  expect(details.status).toBe("forbidden");
  expect(details.error).toBe("Leaf subagents cannot control other sessions.");
  expect(callGatewayMock).not.toHaveBeenCalled();
}

describe("openclaw-tools: subagents scope isolation", () => {
  let stateDir = "";

  beforeEach(async () => {
    resetSubagentRegistryForTests();
    resetSubagentsConfigOverride();
    callGatewayMock.mockReset();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagents-scope-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    setSubagentsConfigOverride({
      session: createPerSenderSessionConfig({}),
    });
    writeStore({});
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("leaf subagents do not inherit parent sibling control scope", async () => {
    const leafKey = "agent:main:subagent:leaf";
    const siblingKey = "agent:main:subagent:unsandboxed";

    writeStore({
      [leafKey]: {
        sessionId: "leaf-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
      },
      [siblingKey]: {
        sessionId: "sibling-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
      },
    });

    addSubagentRunForTests({
      runId: "run-leaf",
      childSessionKey: leafKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "sandboxed leaf",
      cleanup: "keep",
      createdAt: Date.now() - 30_000,
      startedAt: Date.now() - 30_000,
    });
    addSubagentRunForTests({
      runId: "run-sibling",
      childSessionKey: siblingKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "unsandboxed sibling",
      cleanup: "keep",
      createdAt: Date.now() - 20_000,
      startedAt: Date.now() - 20_000,
    });

    const tool = createSubagentsTool({ agentSessionKey: leafKey });
    const result = await tool.execute("call-leaf-list", { action: "list" });

    const details = result.details as {
      status?: string;
      requesterSessionKey?: string;
      callerSessionKey?: string;
      callerIsSubagent?: boolean;
      total?: number;
      active?: unknown[];
      recent?: unknown[];
    };
    expect(details.status).toBe("ok");
    expect(details.requesterSessionKey).toBe(leafKey);
    expect(details.callerSessionKey).toBe(leafKey);
    expect(details.callerIsSubagent).toBe(true);
    expect(details.total).toBe(0);
    expect(details.active).toEqual([]);
    expect(details.recent).toEqual([]);
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("orchestrator subagents still see children they spawned", async () => {
    const orchestratorKey = "agent:main:subagent:orchestrator";
    const workerKey = `${orchestratorKey}:subagent:worker`;
    const siblingKey = "agent:main:subagent:sibling";

    writeStore({
      [orchestratorKey]: {
        sessionId: "orchestrator-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
      },
      [workerKey]: {
        sessionId: "worker-session",
        updatedAt: Date.now(),
        spawnedBy: orchestratorKey,
      },
      [siblingKey]: {
        sessionId: "sibling-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
      },
    });

    addSubagentRunForTests({
      runId: "run-worker",
      childSessionKey: workerKey,
      requesterSessionKey: orchestratorKey,
      requesterDisplayKey: orchestratorKey,
      task: "worker child",
      cleanup: "keep",
      createdAt: Date.now() - 30_000,
      startedAt: Date.now() - 30_000,
    });
    addSubagentRunForTests({
      runId: "run-sibling",
      childSessionKey: siblingKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "sibling of orchestrator",
      cleanup: "keep",
      createdAt: Date.now() - 20_000,
      startedAt: Date.now() - 20_000,
    });

    const tool = createSubagentsTool({ agentSessionKey: orchestratorKey });
    const result = await tool.execute("call-orchestrator-list", { action: "list" });
    const details = result.details as {
      status?: string;
      requesterSessionKey?: string;
      total?: number;
      active?: Array<{ sessionKey?: string }>;
    };

    expect(details.status).toBe("ok");
    expect(details.requesterSessionKey).toBe(orchestratorKey);
    expect(details.total).toBe(1);
    expect(details.active).toHaveLength(1);
    expect(details.active?.[0]?.sessionKey).toBe(workerKey);
  });

  it("leaf subagents cannot kill even explicitly-owned child sessions", async () => {
    await expectLeafSubagentControlForbidden({
      action: "kill",
      callId: "call-leaf-kill",
    });
  });

  it("leaf subagents cannot steer even explicitly-owned child sessions", async () => {
    await expectLeafSubagentControlForbidden({
      action: "steer",
      callId: "call-leaf-steer",
      message: "continue",
    });
  });
});
