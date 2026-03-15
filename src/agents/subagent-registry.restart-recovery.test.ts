import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { callGatewaySpy, announceSpy } = vi.hoisted(() => ({
  callGatewaySpy: vi.fn(),
  announceSpy: vi.fn(async () => true),
}));

const noop = () => {};

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewaySpy,
  randomIdempotencyKey: () => "test-idem-key",
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn(() => noop),
}));

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
  captureSubagentCompletionReply: vi.fn(async () => undefined),
}));

import { captureEnv } from "../test-utils/env.js";
import {
  initSubagentRegistry,
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";
import { loadSubagentRegistryFromDisk } from "./subagent-registry.store.js";

describe("subagent restart recovery", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;

  const resolveAgentIdFromSessionKey = (sessionKey: string) => {
    const match = sessionKey.match(/^agent:([^:]+):/i);
    return (match?.[1] ?? "main").trim().toLowerCase() || "main";
  };

  const resolveSessionStorePath = (stateDir: string, agentId: string) =>
    path.join(stateDir, "agents", agentId, "sessions", "sessions.json");

  const readSessionStore = async (storePath: string) => {
    try {
      const raw = await fs.readFile(storePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, Record<string, unknown>>;
      }
    } catch {
      // ignore
    }
    return {} as Record<string, Record<string, unknown>>;
  };

  const writeChildSessionEntry = async (params: {
    sessionKey: string;
    sessionId?: string;
    updatedAt?: number;
  }) => {
    if (!tempStateDir) {
      throw new Error("tempStateDir not initialized");
    }
    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    const storePath = resolveSessionStorePath(tempStateDir, agentId);
    const store = await readSessionStore(storePath);
    store[params.sessionKey] = {
      ...store[params.sessionKey],
      sessionId: params.sessionId ?? `sess-${agentId}-${Date.now()}`,
      updatedAt: params.updatedAt ?? Date.now(),
    };
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, `${JSON.stringify(store)}\n`, "utf8");
    return storePath;
  };

  const writePersistedRegistry = async (persisted: Record<string, unknown>) => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-restart-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const registryPath = path.join(tempStateDir, "subagents", "runs.json");
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, `${JSON.stringify(persisted)}\n`, "utf8");
    // Seed child session entries
    const runs = (persisted.runs ?? {}) as Record<
      string,
      { runId?: string; childSessionKey?: string }
    >;
    for (const [runId, run] of Object.entries(runs)) {
      const childSessionKey = run?.childSessionKey?.trim();
      if (!childSessionKey) {
        continue;
      }
      await writeChildSessionEntry({
        sessionKey: childSessionKey,
        sessionId: `sess-${run.runId ?? runId}`,
      });
    }
    return registryPath;
  };

  const flushQueuedRegistryWork = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  afterEach(async () => {
    callGatewaySpy.mockReset();
    announceSpy.mockClear();
    resetSubagentRegistryForTests({ persist: false });
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    envSnapshot.restore();
  });

  it("retriggers subagent with continuation message after restart for incomplete run", async () => {
    const now = Date.now();
    const persisted = {
      version: 2,
      runs: {
        "run-active": {
          runId: "run-active",
          childSessionKey: "agent:main:subagent:active-child",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          requesterOrigin: { channel: "bluebubbles", accountId: "acct-1" },
          task: "do something complex",
          cleanup: "keep",
          label: "complex-task",
          createdAt: now - 5000,
          startedAt: now - 4000,
          // No endedAt — the run was in progress when gateway restarted
        },
      },
    };

    // Mock callGateway: "agent" returns new runId, "agent.wait" returns ok
    callGatewaySpy.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "agent") {
        return { runId: "run-active-v2" };
      }
      if (opts.method === "agent.wait") {
        return { status: "ok", startedAt: now, endedAt: now + 1000 };
      }
      return {};
    });

    await writePersistedRegistry(persisted);
    resetSubagentRegistryForTests({ persist: false });
    initSubagentRegistry();
    await flushQueuedRegistryWork();

    // Verify callGateway was called with method "agent" for re-triggering
    const agentCalls = callGatewaySpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method: string }).method === "agent",
    );
    expect(agentCalls.length).toBeGreaterThanOrEqual(1);

    const agentCallParams = (agentCalls[0][0] as { params: Record<string, unknown> }).params;
    expect(agentCallParams.sessionKey).toBe("agent:main:subagent:active-child");
    // Verify continuation message is sent
    expect(agentCallParams.message).toContain("gateway process restarted");
    expect(agentCallParams.deliver).toBe(false);
    expect(agentCallParams.lane).toBeDefined();
    expect(agentCallParams.label).toBe("complex-task");
  });

  it("marks run as errored when retrigger agent call fails", async () => {
    const now = Date.now();
    const persisted = {
      version: 2,
      runs: {
        "run-fail": {
          runId: "run-fail",
          childSessionKey: "agent:main:subagent:fail-child",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "doomed task",
          cleanup: "keep",
          createdAt: now - 5000,
          startedAt: now - 4000,
          // No endedAt
        },
      },
    };

    callGatewaySpy.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "agent") {
        throw new Error("gateway unreachable");
      }
      return {};
    });

    const registryPath = await writePersistedRegistry(persisted);
    resetSubagentRegistryForTests({ persist: false });
    initSubagentRegistry();
    await flushQueuedRegistryWork();

    // The run should be marked as ended with an error
    const persistedAfter = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs?: Record<string, { endedAt?: number; outcome?: { status: string; error?: string } }>;
    };

    const run = persistedAfter.runs?.["run-fail"];
    expect(run?.endedAt).toBeDefined();
    expect(run?.outcome?.status).toBe("error");
    expect(run?.outcome?.error).toContain("restart recovery failed");
  });

  it("falls back to wait when retrigger returns no runId", async () => {
    const now = Date.now();
    const persisted = {
      version: 2,
      runs: {
        "run-no-id": {
          runId: "run-no-id",
          childSessionKey: "agent:main:subagent:no-id-child",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "task with no runId",
          cleanup: "keep",
          createdAt: now - 5000,
          startedAt: now - 4000,
          // No endedAt
        },
      },
    };

    callGatewaySpy.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "agent") {
        return {}; // No runId returned
      }
      if (opts.method === "agent.wait") {
        return { status: "ok", startedAt: now, endedAt: now + 1000 };
      }
      return {};
    });

    await writePersistedRegistry(persisted);
    resetSubagentRegistryForTests({ persist: false });
    initSubagentRegistry();
    await flushQueuedRegistryWork();

    // Should have called agent.wait as fallback
    const waitCalls = callGatewaySpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method: string }).method === "agent.wait",
    );
    expect(waitCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("does not retrigger runs that already have endedAt set", async () => {
    const now = Date.now();
    const persisted = {
      version: 2,
      runs: {
        "run-ended": {
          runId: "run-ended",
          childSessionKey: "agent:main:subagent:ended-child",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "already done",
          cleanup: "keep",
          createdAt: now - 5000,
          startedAt: now - 4000,
          endedAt: now - 1000, // Already ended
        },
      },
    };

    callGatewaySpy.mockImplementation(async () => ({}));
    announceSpy.mockResolvedValue(true);

    await writePersistedRegistry(persisted);
    resetSubagentRegistryForTests({ persist: false });
    initSubagentRegistry();
    await flushQueuedRegistryWork();

    // No "agent" method calls for re-triggering (only cleanup/announce flows)
    const agentCalls = callGatewaySpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method: string }).method === "agent",
    );
    expect(agentCalls).toHaveLength(0);
  });
});
