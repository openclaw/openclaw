// Exercise overlapping completion callbacks against real registry and SQLite state.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import "./subagent-registry.persistence.mocks.test-support.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/config.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { callGateway } from "../../../gateway/call.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import { flushLogger, setLoggerOverride } from "../../../logging/logger.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../../state/openclaw-agent-write-admission.js";
import { configureTaskRegistryMaintenance } from "../../../tasks/task-registry.maintenance.js";
import { getTaskRegistryStore } from "../../../tasks/task-registry.store.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import {
  cleanupSubagentRegistryPersistenceTest,
  readSubagentSessionStore,
  settleSubagentRegistryPersistenceWork,
} from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import {
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";

const { announce } = vi.hoisted(() => ({ announce: vi.fn(async () => "delivered" as const) }));
vi.mock("../announce/subagent-announce.js", async (importOriginal) => {
  const { hasUsableSessionEntry } =
    await importOriginal<typeof import("../announce/subagent-announce.js")>();
  return {
    hasUsableSessionEntry,
    runSubagentAnnounceFlow: announce,
    captureSubagentCompletionReply: vi.fn(async () => undefined),
  };
});
vi.mock("./subagent-registry-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry-state.js")>();
  const { saveSubagentRegistryToSqlite } = await import("./subagent-registry.store.sqlite.js");
  return { ...actual, persistSubagentRunsToDisk: saveSubagentRegistryToSqlite };
});

describe("subagent timing completion", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let stateDir: string;
  let logFile: string;

  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    stateDir = tempDirs.make("openclaw-subagent-timing-reproduction-");
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    logFile = path.join(stateDir, "reproduction.log");
    setLoggerOverride({ level: "warn", file: logFile, consoleLevel: "silent" });
    configureTaskRegistryMaintenance({ runtimeAuthoritative: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    announce.mockClear();
    vi.mocked(callGateway).mockReset();
    vi.mocked(onAgentEvent).mockReset();
    vi.mocked(onAgentEvent).mockReturnValue(() => undefined);
  });

  afterEach(async () => {
    await cleanupSubagentRegistryPersistenceTest({
      stateDir,
      resetRegistry: () => resetSubagentRegistryForTests({ persist: false }),
      closeDatabases: () => {
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      },
    });
    configureTaskRegistryMaintenance({ runtimeAuthoritative: false });
    setLoggerOverride(null);
    clearRuntimeConfigSnapshot();
    envSnapshot.restore();
  });

  it.each(["wait-only", "sequential", "overlap"] as const)("%s", async (mode) => {
    const runId = `timing-repro-${mode}`;
    const childSessionKey = `agent:main:subagent:${mode}`;
    const requesterSessionKey = "agent:main:main";
    const seededAt = Date.now();
    const terminalReply = { disposition: "visible" as const, text: "Synthetic completed result." };
    const waiting = createDeferred<{
      status: string;
      startedAt: number;
      endedAt: number;
      terminalReply: typeof terminalReply;
    }>();
    vi.mocked(callGateway).mockImplementation(async (request) => {
      expect(request.method).toBe("agent.wait");
      return await waiting.promise;
    });

    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    // Seed through the real accessor, suppressing only setup maintenance so
    // pending FIFO jobs below can only be the two terminal timing writes.
    for (const [sessionKey, sessionId] of [
      [childSessionKey, `session-${mode}`],
      [requesterSessionKey, `requester-${mode}`],
    ] as const) {
      const entry = { sessionId, updatedAt: seededAt - 1 };
      await patchSessionEntryCore({ storePath, sessionKey }, () => entry, {
        fallbackEntry: entry,
        replaceEntry: true,
        skipMaintenance: true,
      });
    }
    registerSubagentRun({
      runId,
      childSessionKey,
      requesterSessionKey,
      requesterDisplayKey: "main",
      task: "Synthetic timing reproduction",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
    await vi.waitFor(() => expect(callGateway).toHaveBeenCalled());
    const readRun = () => loadSubagentRegistryFromSqlite().get(runId);
    const startedAt = readRun()?.sessionStartedAt;
    if (typeof startedAt !== "number") {
      throw new Error("registration did not persist sessionStartedAt");
    }
    const endedAt = startedAt + 500;
    const terminal = { status: "ok", startedAt, endedAt, terminalReply };

    // Deliver through the callbacks installed by the production event listener.
    const emitTerminal = () => {
      const event = {
        runId,
        seq: 1,
        stream: "lifecycle",
        ts: endedAt,
        sessionKey: childSessionKey,
        data: { phase: "end", startedAt, endedAt, stopReason: "stop", terminalReply },
      };
      for (const [listener] of vi.mocked(onAgentEvent).mock.calls) {
        listener(event);
      }
    };
    const waitForCleanup = async () => {
      await vi.waitFor(() => expect(readRun()?.cleanupCompletedAt).toEqual(expect.any(Number)));
      await settleSubagentRegistryPersistenceWork();
    };
    if (mode === "overlap") {
      const entered = createDeferred();
      const released = createDeferred();
      // Hold the real FIFO with a no-op patch. There is no open SQLite
      // transaction during this await and no production function is replaced.
      const blocker = patchSessionEntryCore(
        { storePath, sessionKey: childSessionKey },
        async () => {
          entered.resolve();
          await released.promise;
          return null;
        },
        { skipMaintenance: true },
      );
      try {
        await entered.promise;
        const queueDepth = () =>
          SQLITE_SESSION_WRITER_QUEUES.get(resolveOpenClawAgentSqlitePath({ agentId: "main" }))
            ?.pending.length ?? 0;
        expect(queueDepth()).toBe(0);
        emitTerminal();
        await vi.waitFor(() => expect(queueDepth()).toBe(1));
        waiting.resolve(terminal);
        await vi.waitFor(() => expect(queueDepth()).toBe(2));
      } finally {
        waiting.resolve(terminal);
        released.resolve();
        await blocker;
      }
      await waitForCleanup();
    } else {
      waiting.resolve(terminal);
      await waitForCleanup();
      if (mode === "sequential") {
        emitTerminal();
        await settleSubagentRegistryPersistenceWork();
      }
    }

    // Read the durable projection, not a mock return or the registry's memory.
    const session = (await readSubagentSessionStore(storePath))[childSessionKey];
    const registry = readRun();
    expect(session).toMatchObject({ status: "done", startedAt, endedAt, runtimeMs: 500 });
    expect(registry?.execution).toMatchObject({
      status: "terminal",
      outcome: { status: "ok" },
      endedAt,
    });
    expect(registry?.delivery?.status).toBe("delivered");
    const task = [...getTaskRegistryStore().loadSnapshot().tasks.values()].find(
      (candidate) => candidate.runId === runId,
    );
    expect(task?.status).toBe("succeeded");
    expect(announce).toHaveBeenCalledTimes(1);
    await flushLogger();
    const text = await fs.readFile(logFile, "utf8").catch(() => "");
    const records = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const warnings = records.filter((record) =>
      Object.values(record).includes("failed to persist subagent session timing"),
    );
    const errors = records.filter((record) =>
      Object.values(record).includes("SQLite session write failed"),
    );
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
  });
});
