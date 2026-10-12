import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { callGateway } from "../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import * as gatewayWorkAdmission from "../../process/gateway-work-admission.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import {
  createRestartRecoveryStoreFixture,
  mainSessionEntry,
  makePendingFinalDelivery,
  readStore,
} from "./main-session-restart-recovery-fixture.test-support.js";
import {
  discoverRestartRecoveryStoreTargets,
  mainSessionRecoveryLog,
} from "./main-session-restart-recovery-shared.js";
import {
  markStartupOrphanedMainSessionsForRecovery,
  recoverRestartAbortedMainSessions as recoverRestartAbortedMainSessionsBase,
  scheduleRestartAbortedMainSessionRecovery as scheduleRestartAbortedMainSessionRecoveryBase,
} from "./main-session-restart-recovery.js";

// mock-isolation: Recovery dispatch uses the fixture runtime without a Gateway connection.
vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

const sendRecoveryNotice = vi.fn<GatewayRecoveryRuntime["sendRecoveryNotice"]>(async () => ({
  suppressed: false,
}));
let dispatchSettlement = createDeferred();
const mockRecoveryRuntime = createRecoveryRuntimeFixture({
  callGateway,
  getDispatchSettlement: () => dispatchSettlement.promise,
  sendRecoveryNotice,
});
const recoverRestartAbortedMainSessions = (
  params: Omit<Parameters<typeof recoverRestartAbortedMainSessionsBase>[0], "gatewayRuntime">,
) => recoverRestartAbortedMainSessionsBase({ gatewayRuntime: mockRecoveryRuntime, ...params });
const scheduleRestartAbortedMainSessionRecovery = (
  params: Omit<
    Parameters<typeof scheduleRestartAbortedMainSessionRecoveryBase>[0],
    "gatewayRuntime"
  >,
) =>
  scheduleRestartAbortedMainSessionRecoveryBase({ gatewayRuntime: mockRecoveryRuntime, ...params });

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-startup-recovery-");
let tmpDir: string;
const { makeSessionsDir, writeStore, writeTranscript, writeCompletedToolTranscript } =
  createRestartRecoveryStoreFixture(() => tmpDir);

beforeEach(() => {
  vi.clearAllMocks();
  dispatchSettlement = createDeferred();
  vi.mocked(callGateway).mockReset();
  vi.mocked(callGateway).mockImplementation(async () => ({ runId: "run-resumed" }));
  resetAgentEventsForTest();
  resetGatewayWorkAdmission();
  tmpDir = tempDirs.make();
});

afterEach(() => resetGatewayWorkAdmission());

describe("main-session startup recovery", () => {
  it("preserves a claimless delivered continuation but marks one with only older receipts", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const delivered = mainSessionEntry({
      mainRestartRecovery: undefined,
      lifecycleRunId: "interrupted-continuation",
      activeWriterRunId: "interrupted-continuation",
      restartRecoveryDeliverySourceRunId: "completed-source",
      restartRecoveryTerminalRunIds: ["completed-source", "interrupted-continuation"],
      restartRecoveryTerminalDeliveryEvidence: [
        {
          runId: "completed-source",
          transcriptRunId: "interrupted-continuation",
          captured: true,
          payloads: [{ visible: true }],
        },
      ],
    });
    await writeStore(sessionsDir, {
      "agent:main:delivered": delivered,
      "agent:main:undelivered": {
        ...delivered,
        sessionId: "undelivered-session",
        lifecycleRunId: "undelivered-continuation",
        activeWriterRunId: "undelivered-continuation",
        restartRecoveryDeliverySourceRunId: "undelivered-source",
      },
    });
    const before = readStore(storePath);

    expect(await markStartupOrphanedMainSessionsForRecovery({ stateDir: tmpDir })).toEqual({
      marked: 1,
      skipped: 0,
    });

    const after = readStore(storePath);
    expect(after["agent:main:delivered"]).toEqual(before["agent:main:delivered"]);
    expect(after["agent:main:undelivered"]).toMatchObject({
      status: "interrupted",
      abortedLastRun: true,
      mainRestartRecovery: { chargedAttempts: 0 },
      restartRecoveryTerminalRunIds: ["completed-source", "interrupted-continuation"],
    });
  });

  it("recovers unclaimed interruptions without taking archived, live, or newer turns", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const cutoff = Date.now();
    const interrupted = mainSessionEntry({
      updatedAt: cutoff - 10_000,
      mainRestartRecovery: undefined,
      restartRecoveryRuns: undefined,
      activeWriterRunId: "prior-process-run",
    });
    const entries: Record<string, SessionEntry> = {
      "agent:main:interrupted": interrupted,
      "agent:main:flag-only": { ...interrupted, sessionId: "flag-only", status: undefined },
      "agent:main:status-only": { ...interrupted, sessionId: "status-only", abortedLastRun: false },
      "agent:main:archived": { ...interrupted, sessionId: "archived", archivedAt: cutoff - 5_000 },
      "agent:main:archived-claim": mainSessionEntry({
        sessionId: "archived-claim",
        archivedAt: cutoff - 5_000,
        pendingWorktree: { titleSource: "old-work" },
      }),
      "agent:main:live": { ...interrupted, sessionId: "live", activeWriterRunId: "live-run" },
      "agent:main:cancelled": { ...interrupted, sessionId: "cancelled", status: "killed" },
      "agent:main:newer": {
        ...interrupted,
        sessionId: "newer",
        status: undefined,
        abortedLastRun: false,
      },
      "agent:main:fresh": { ...interrupted, sessionId: "fresh", updatedAt: cutoff + 1 },
    };
    await writeStore(sessionsDir, entries);
    for (const sessionId of ["main-session", "flag-only", "status-only"]) {
      await writeTranscript(sessionsDir, sessionId, [
        { role: "user", content: "finish this turn" },
      ]);
    }
    const before = readStore(storePath);
    const claim = claimAgentRunContext(
      "live-run",
      {
        sessionId: "live",
        sessionKey: "agent:main:live",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      },
      { trackOwner: true },
    );
    const info = vi.spyOn(mainSessionRecoveryLog, "info");
    try {
      expect(
        await markStartupOrphanedMainSessionsForRecovery({
          stateDir: tmpDir,
          updatedBeforeMs: cutoff,
        }),
      ).toMatchObject({ marked: 3 });
      const marked = readStore(storePath);
      for (const key of [
        "agent:main:interrupted",
        "agent:main:flag-only",
        "agent:main:status-only",
      ]) {
        expect(marked[key]).toMatchObject({
          status: "interrupted",
          abortedLastRun: true,
          mainRestartRecovery: { chargedAttempts: 0 },
        });
      }
      for (const key of [
        "agent:main:archived",
        "agent:main:archived-claim",
        "agent:main:live",
        "agent:main:cancelled",
        "agent:main:newer",
        "agent:main:fresh",
      ]) {
        expect(marked[key]).toEqual(before[key]);
      }
      expect(await recoverRestartAbortedMainSessions({ stateDir: tmpDir })).toEqual({
        started: 3,
        settled: 0,
        failed: 0,
        skipped: 1,
      });
      expect(callGateway).toHaveBeenCalledTimes(3);
      expect(info.mock.calls.map(([line]) => line)).toContainEqual(
        expect.stringContaining("skipReasons=archived:1"),
      );
      expect(info.mock.calls.map(([line]) => line)).toContainEqual(
        expect.stringContaining('"decision":"deferred","reason":"archived","nextOwner":"none"'),
      );
    } finally {
      info.mockRestore();
      releaseAgentRunContext("live-run", claim);
    }
  });

  it.each([
    { selection: "all", agentIds: undefined },
    { selection: "unrelated logical owner", agentIds: new Set(["main"]) },
    { selection: "physical owner", agentIds: new Set(["old"]) },
  ])(
    "selects a configured fixed store by its physical owner ($selection)",
    async ({ agentIds, selection }) => {
      const sessionsDir = await makeSessionsDir("old");
      const storePath = path.join(sessionsDir, "sessions.json");
      await writeStore(sessionsDir, { "agent:old:main": mainSessionEntry() });

      const cfg = {
        agents: { entries: { main: {} } },
        session: { store: storePath },
      } as OpenClawConfig;

      const targets = await discoverRestartRecoveryStoreTargets({
        cfg,
        agentIds,
        stateDir: tmpDir,
      });
      expect(targets).toEqual(
        selection === "unrelated logical owner" ? [] : [{ agentId: "old", storePath }],
      );
    },
  );

  it("marks startup-orphaned admission claims before recovery", async () => {
    const sessionsDir = await makeSessionsDir();
    const cutoff = Date.now();
    const archivedKey = "agent:main:archived";
    const archived: SessionEntry = {
      sessionId: "archived-session",
      updatedAt: cutoff - 10_000,
      archivedAt: cutoff - 5_000,
      status: "interrupted",
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "archived-recovery",
      restartRecoveryDeliverySourceRunId: "archived-source",
      pendingFinalDelivery: makePendingFinalDelivery(),
    };
    await writeStore(sessionsDir, {
      [archivedKey]: archived,
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: cutoff - 10_000,
        restartRecoveryRuns: [{ runId: "main-run", lifecycleGeneration: "prior-process" }],
      },
      "agent:main:active-key": {
        sessionId: "active-key-session",
        updatedAt: cutoff - 10_000,
        restartRecoveryDeliveryRunId: "active-key-run",
      },
      "agent:main:active-id": {
        sessionId: "active-id-session",
        updatedAt: cutoff - 10_000,
        restartRecoveryDeliveryRunId: "active-id-run",
      },
      "agent:main:fresh": {
        sessionId: "fresh-session",
        updatedAt: cutoff + 1,
        restartRecoveryDeliveryRunId: "fresh-run",
      },
      "agent:main:subagent:child": {
        sessionId: "child-session",
        updatedAt: cutoff - 10_000,
        restartRecoveryDeliveryRunId: "child-run",
        spawnDepth: 1,
      },
      "agent:main:cron:nightly": {
        sessionId: "cron-session",
        updatedAt: cutoff - 10_000,
        restartRecoveryDeliveryRunId: "cron-run",
      },
      "agent:main:completed": {
        sessionId: "completed-session",
        updatedAt: cutoff - 10_000,
        status: "done",
        mainRestartRecovery: { cycleId: "completed-cycle", revision: 1, chargedAttempts: 0 },
        restartRecoveryTerminalRunIds: ["completed-prior-process-run"],
        restartRecoveryRuns: [
          {
            runId: "completed-prior-process-run",
            lifecycleGeneration: "prior-process",
          },
        ],
      },
      "agent:main:already-marked": {
        sessionId: "already-marked-session",
        updatedAt: cutoff - 10_000,
        status: "interrupted",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "marked-prior-process-run",
            lifecycleGeneration: "prior-process",
          },
        ],
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, "already-marked-session", [
      { role: "user", content: "already interrupted" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, archived.sessionId, [
      { role: "user", content: "do not recover while archived" },
    ]);
    const storePath = path.join(sessionsDir, "sessions.json");
    const before = readStore(storePath);
    const archivedScope = {
      agentId: "main",
      sessionKey: archivedKey,
      sessionId: archived.sessionId,
      storePath,
    };
    const archivedHistory = await loadTranscriptEvents(archivedScope);

    const marked = await markStartupOrphanedMainSessionsForRecovery({
      stateDir: tmpDir,
      activeSessionKeys: ["agent:main:active-key"],
      activeSessionIds: ["active-key-session", "active-id-session"],
      updatedBeforeMs: cutoff,
    });

    expect(marked).toEqual({ marked: 1, skipped: 3 });
    let store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:active-key"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:active-id"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:fresh"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:subagent:child"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:cron:nightly"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:completed"]?.abortedLastRun).toBe(false);
    expect(store["agent:main:already-marked"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:completed"]?.restartRecoveryRuns).toBeUndefined();
    expect(store["agent:main:already-marked"]?.restartRecoveryRuns).toHaveLength(1);

    const recovered = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(recovered).toEqual({ started: 2, settled: 0, failed: 0, skipped: 1 });
    expect(callGateway).toHaveBeenCalledTimes(2);
    store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
    expect(store["agent:main:already-marked"]?.abortedLastRun).toBe(false);
    for (const key of [archivedKey, "agent:main:active-key", "agent:main:active-id"]) {
      expect(store[key]).toEqual(before[key]);
    }
    expect(await loadTranscriptEvents(archivedScope)).toEqual(archivedHistory);
  });

  it.each<{
    name: string;
    residue: Partial<SessionEntry>;
  }>([
    {
      name: "a stale before-reply phase",
      residue: { restartRecoveryBeforeAgentReplyState: "pending" },
    },
    {
      name: "an incomplete terminal-delivery receipt",
      residue: { restartRecoveryDeliveryReceiptState: "delivered-terminal" },
    },
    {
      name: "a completed delivery claim with a stale handled phase",
      residue: {
        restartRecoveryDeliveryRunId: "finished-run",
        restartRecoveryBeforeAgentReplyState: "handled-reply",
      },
    },
  ])("does not resume completed work from $name", async ({ residue }) => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        sessionId: "main-session",
        updatedAt: 200,
        startedAt: 100,
        endedAt: 200,
        runtimeMs: 100,
        status: "done",
        abortedLastRun: false,
        ...residue,
      },
    });
    await writeCompletedToolTranscript(sessionsDir);

    await markStartupOrphanedMainSessionsForRecovery({ stateDir: tmpDir });
    await expect(recoverRestartAbortedMainSessions({ stateDir: tmpDir })).resolves.toMatchObject({
      started: 0,
      failed: 0,
    });

    expect(callGateway).not.toHaveBeenCalled();
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry).toMatchObject({
      status: "done",
      abortedLastRun: false,
      startedAt: 100,
      endedAt: 200,
      runtimeMs: 100,
    });
    expect(entry?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(entry?.mainRestartRecovery).toBeUndefined();
    expect(entry?.restartRecoveryRuns).toBeUndefined();
  });

  it.for([
    { publication: "during the initial scan", owner: "main", shared: false },
    { publication: "after the initial scan", owner: "main", shared: false },
    { publication: "after stop", owner: "main", shared: false },
    { publication: "after the initial scan", owner: "old", shared: false },
    { publication: "after the initial scan", owner: "old", shared: true },
  ])(
    "observes deferred database admission $publication (owner=$owner, shared=$shared)",
    async ({ publication, owner, shared }, { signal }) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
        const sessionsDir =
          owner === "old" ? path.join(tmpDir, "custom-store") : await makeSessionsDir();
        await fs.mkdir(sessionsDir, { recursive: true });
        const logicalOwner = shared ? "main" : owner;
        const sessionKey = `agent:${logicalOwner}:main`;
        const freshSessionKey = `agent:${logicalOwner}:fresh`;
        const storePath = path.join(sessionsDir, shared ? "shared.sqlite" : "sessions.json");
        const cfg: OpenClawConfig =
          owner === "old"
            ? { agents: { entries: { main: {} } }, session: { store: storePath } }
            : {};
        if (shared) {
          openOpenClawAgentDatabase({ agentId: owner, path: storePath });
        }
        await replaceSessionEntry(
          { agentId: logicalOwner, sessionKey, storePath },
          mainSessionEntry({
            status: undefined,
            abortedLastRun: undefined,
            mainRestartRecovery: undefined,
            restartRecoveryRuns: [
              { runId: "prior-process-run", lifecycleGeneration: "prior-process" },
            ],
          }),
        );
        for (const message of [
          { role: "user", content: "resume after database admission" },
          { role: "toolResult", content: "main result" },
        ]) {
          await appendTranscriptMessage(
            { agentId: logicalOwner, sessionKey, sessionId: "main-session", storePath },
            { cwd: sessionsDir, message },
          );
        }
        const env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
        const refusal = createAgentDatabaseInspectionRefusal({
          agentId: owner,
          paths: [],
          reason: "Startup inspection is pending",
          pending: true,
        });
        recordAgentDatabaseAdmissions([refusal], { env });
        const info = vi.spyOn(mainSessionRecoveryLog, "info");
        const resumed = createDeferred<unknown>();
        const scanned = createDeferred();
        const releaseScan = createDeferred();
        const admit = gatewayWorkAdmission.runWithGatewayDetachedWorkAdmission;
        let initialPass: Promise<unknown> | undefined;
        const admissionSpy = vi
          .spyOn(gatewayWorkAdmission, "runWithGatewayDetachedWorkAdmission")
          .mockImplementation(
            <T>(
              run: () => Promise<T>,
              origin?: string,
              admissionSignal?: AbortSignal,
            ): Promise<T> => {
              const pass = admit(run, origin, admissionSignal);
              if (origin !== "main-session:startup-recovery") {
                return pass;
              }
              if (initialPass) {
                return pass.then((result) => {
                  resumed.resolve(result);
                  return result;
                });
              }
              const held = pass.then(async (result) => {
                scanned.resolve();
                await releaseScan.promise;
                return result;
              });
              initialPass = held;
              return held;
            },
          );
        const recovery = scheduleRestartAbortedMainSessionRecovery({
          getConfig: () => cfg,
          delayMs: 0,
          maxRetries: 1,
          stateDir: tmpDir,
        });
        try {
          await withinTest(scanned.promise, signal);
          expect(callGateway).not.toHaveBeenCalled();
          if (publication !== "during the initial scan") {
            releaseScan.resolve();
            await initialPass;
          }
          if (publication === "after stop") {
            await recovery.stop();
          }
          await preparePendingAgentDatabase(refusal, { env, assertCurrent() {} }, async () => {
            await replaceSessionEntry(
              { agentId: logicalOwner, sessionKey: freshSessionKey, storePath },
              mainSessionEntry({
                sessionId: "fresh-session",
                updatedAt: Date.now() + 1_000,
                status: undefined,
                abortedLastRun: undefined,
                mainRestartRecovery: undefined,
                restartRecoveryRuns: [
                  {
                    runId: "fresh-process-run",
                    lifecycleGeneration: getAgentEventLifecycleGeneration(),
                  },
                ],
              }),
            );
          });
          sessionChanges.emit({ all: true, scope: { agentId: owner, topology: true } });
          releaseScan.resolve();
          if (publication === "after stop") {
            await recovery.stop();
            expect(callGateway).not.toHaveBeenCalled();
          } else {
            expect(
              await withinTest(resumed.promise, signal),
              info.mock.calls.map(([line]) => line).join("\n"),
            ).toMatchObject({ started: 1, failed: 0 });
            await mockRecoveryRuntime.expectAdmission(1, recovery, {
              sessionKey,
              storePath,
            });
            const fresh = loadSessionEntry({
              agentId: logicalOwner,
              sessionKey: freshSessionKey,
              storePath,
            });
            expect(fresh).toMatchObject({
              sessionId: "fresh-session",
            });
            expect(fresh?.status).toBeUndefined();
            expect(fresh?.abortedLastRun).not.toBe(true);
          }
        } finally {
          releaseScan.resolve();
          await recovery.stop();
          admissionSpy.mockRestore();
          info.mockRestore();
          recordAgentDatabaseAdmissions([], { env });
        }
      });
    },
  );
});
