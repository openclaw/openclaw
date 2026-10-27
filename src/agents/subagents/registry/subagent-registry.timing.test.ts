import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import "./subagent-registry.persistence.mocks.test-support.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/config.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { callGateway } from "../../../gateway/call.js";
import { racePromiseWithAbortSignal } from "../../../infra/abort-signal.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import { flushLogger, setLoggerOverride } from "../../../logging/logger.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../../state/openclaw-agent-write-admission-state.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import {
  cleanupSubagentRegistryPersistenceTest,
  readSubagentSessionStore,
  settleSubagentRegistryPersistenceWork,
} from "./subagent-registry.persistence.test-support.js";
import {
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";

const { announce } = vi.hoisted(() => ({ announce: vi.fn(async () => "delivered" as const) }));
vi.mock("../announce/subagent-announce.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../announce/subagent-announce.js")>()),
  runSubagentAnnounceFlow: announce,
  captureSubagentCompletionReply: vi.fn(async () => undefined),
}));

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
let logFile: string;
let settleRootWork: ReturnType<typeof observeRootWork>;

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  stateDir = tempDirs.make("openclaw-subagent-timing-reproduction-");
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  logFile = path.join(stateDir, "reproduction.log");
  setLoggerOverride({ level: "warn", file: logFile, consoleLevel: "silent" });
  announce.mockClear();
  vi.mocked(callGateway).mockReset();
  vi.mocked(onAgentEvent)
    .mockReset()
    .mockReturnValue(() => undefined);
  settleRootWork = observeRootWork();
});

afterEach(async () => {
  await cleanupSubagentRegistryPersistenceTest({
    stateDir,
    resetRegistry: () => resetSubagentRegistryForTests({ persist: false }),
    settleOwnedWork: () => settleRootWork(),
  });
  setLoggerOverride(null);
  clearRuntimeConfigSnapshot();
  envSnapshot.restore();
});

it("persists overlapping completion timing without warnings or duplicate announcements", async ({
  signal,
}) => {
  const runId = "timing-repro-overlap";
  const childSessionKey = "agent:main:subagent:overlap";
  const requesterSessionKey = "agent:main:main";
  const seededAt = Date.now();
  const terminalReply = { disposition: "visible" as const, text: "Synthetic completed result." };
  const waiting = createDeferred<{
    status: string;
    startedAt: number;
    endedAt: number;
    terminalReply: typeof terminalReply;
  }>();
  const waitEntered = createDeferred();
  const waitReturned = createDeferred();
  vi.mocked(callGateway).mockImplementation(async (request) => {
    expect(request.method).toBe("agent.wait");
    waitEntered.resolve();
    const result = await waiting.promise;
    waitReturned.resolve();
    return result;
  });

  const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  // Exclude setup maintenance from the FIFO interleaving below.
  for (const [sessionKey, sessionId] of [
    [childSessionKey, "session-overlap"],
    [requesterSessionKey, "requester-overlap"],
  ] as const) {
    const entry = {
      sessionId,
      lifecycleRevision: `${sessionId}-revision`,
      updatedAt: seededAt - 1,
    };
    await patchSessionEntryCore({ storePath, sessionKey }, () => entry, {
      fallbackEntry: entry,
      replaceEntry: true,
      skipMaintenance: true,
    });
  }
  await registerSubagentRun({
    runId,
    childSessionKey,
    childAgentId: "main",
    sessionEntry: { sessionId: "session-overlap", lifecycleRevision: "session-overlap-revision" },
    requesterSessionKey,
    requesterDisplayKey: "main",
    task: "Synthetic timing reproduction",
    cleanup: "keep",
    expectsCompletionMessage: true,
  });
  await waitEntered.promise;
  const readRun = () => loadSubagentRegistryFromSqlite().get(runId);
  const startedAt = readRun()?.sessionStartedAt;
  if (typeof startedAt !== "number") {
    throw new Error("registration did not persist sessionStartedAt");
  }
  const endedAt = startedAt + 500;
  const terminal = { status: "ok", startedAt, endedAt, terminalReply };

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
  const entered = createDeferred();
  const released = createDeferred();
  // Hold the real FIFO without keeping a SQLite transaction open.
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
    const queue = SQLITE_SESSION_WRITER_QUEUES.get(storePath);
    if (!queue) {
      throw new Error("session writer did not retain its queue");
    }
    const lifecycleQueued = createDeferred();
    const push = queue.pending.push.bind(queue.pending);
    using _ = vi.spyOn(queue.pending, "push").mockImplementation((...tasks) => {
      const depth = push(...tasks);
      if (depth === 1) {
        lifecycleQueued.resolve();
      }
      return depth;
    });

    expect(queue.pending.length).toBe(0);
    emitTerminal();
    await racePromiseWithAbortSignal(lifecycleQueued.promise, signal);
    expect(queue.pending.length).toBe(1);
    // Overlap the wait result with the blocked lifecycle callback.
    waiting.resolve(terminal);
    await waitReturned.promise;
  } finally {
    waiting.resolve(terminal);
    released.resolve();
    await blocker;
  }
  await settleSubagentRegistryPersistenceWork(() => settleRootWork(true));
  const session = (await readSubagentSessionStore(storePath))[childSessionKey];
  expect(session).toMatchObject({ status: "done", startedAt, endedAt, runtimeMs: 500 });
  expect(readRun()).toMatchObject({
    cleanupCompletedAt: expect.any(Number),
    execution: { status: "terminal", outcome: { status: "ok" }, endedAt },
    delivery: { status: "delivered" },
  });
  expect(announce).toHaveBeenCalledTimes(1);
  await flushLogger();
  const text = await fs.readFile(logFile, "utf8").catch(() => "");
  const values = text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => Object.values(JSON.parse(line)));
  expect(values).not.toContain("failed to persist subagent session timing");
  expect(values).not.toContain("SQLite session write failed");
});
