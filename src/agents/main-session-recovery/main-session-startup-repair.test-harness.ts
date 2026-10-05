import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { runStartupSessionMaintenanceForTest } from "../../gateway/server-startup-session-migration.test-support.js";
import {
  clearAgentRunContext,
  hasLiveAgentRunContext,
  listAgentRunsForSession,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import * as gatewayWorkAdmission from "../../process/gateway-work-admission.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  createSubagentRunRecord,
  expectRecord,
  type SessionEntryFixture,
} from "../subagent-test-fixtures.test-helpers.js";
import { saveSubagentRegistryToSqlite } from "../subagents/registry/subagent-registry-state.fixture.test-support.js";
import { loadSubagentRegistryFromSqlite } from "../subagents/registry/subagent-registry.store.sqlite.js";
import type { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import { discoverRestartRecoveryStoreTargets } from "./main-session-restart-recovery-shared.js";
import {
  markStartupOrphanedMainSessionsForRecovery,
  recoverRestartAbortedMainSessions,
  scheduleRestartAbortedMainSessionRecovery,
} from "./main-session-restart-recovery.js";

type StartupSessionRepairFixture = {
  tmpDir: string;
  makeSessionsDir: (agentId?: string) => Promise<string>;
  mainSessionEntry: (overrides?: SessionEntryFixture) => SessionEntry;
  writeStore: (sessionsDir: string, store: Record<string, SessionEntryFixture>) => Promise<void>;
  writeTranscript: (
    sessionsDir: string,
    sessionId: string,
    messages: readonly unknown[],
  ) => Promise<void>;
  runningSessionEntry: (sessionId: string, overrides?: SessionEntryFixture) => SessionEntry;
  makePendingFinalDelivery: () => NonNullable<SessionEntry["pendingFinalDelivery"]>;
  readStore: (storePath: string) => Record<string, SessionEntry>;
  expectRecovery: (expected: {
    started: number;
    settled: number;
    failed: number;
    skipped: number;
  }) => Promise<void>;
  gatewayRuntime: ReturnType<typeof createRecoveryRuntimeFixture>;
  dispatchSettlement: { resolve: () => void };
};

export function registerStartupSessionRepairCases(
  getFixture: () => StartupSessionRepairFixture,
): void {
  it.each([
    { selection: "all", agentIds: undefined },
    { selection: "main", agentIds: new Set(["main"]) },
  ])("keeps a configured fixed store with a retired owner ($selection)", async ({ agentIds }) => {
    const { tmpDir, makeSessionsDir, mainSessionEntry, writeStore } = getFixture();
    const sessionsDir = await makeSessionsDir("old");
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, { "agent:old:main": mainSessionEntry() });

    const cfg = {
      agents: { entries: { main: {} } },
      session: { store: storePath },
    } as OpenClawConfig;

    await expect(
      discoverRestartRecoveryStoreTargets({
        cfg,
        agentIds,
        stateDir: tmpDir,
        statuses: ["running"],
      }),
    ).resolves.toContainEqual({ agentId: "old", storePath });
  });

  it.each(["during the initial scan", "after the initial scan", "after stop"] as const)(
    "observes deferred database admission %s",
    async (publication) => {
      const {
        tmpDir,
        makeSessionsDir,
        mainSessionEntry,
        writeStore,
        writeTranscript,
        gatewayRuntime,
      } = getFixture();
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      await writeStore(sessionsDir, {
        "agent:main:main": mainSessionEntry({ abortedLastRun: undefined }),
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "resume after database admission" },
        { role: "toolResult", content: "main result" },
      ]);
      const env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
      const refusal = createAgentDatabaseInspectionRefusal({
        agentId: "main",
        paths: [],
        reason: "Startup inspection is pending",
        pending: true,
      });
      recordAgentDatabaseAdmissions([refusal], { env });
      const scanned = createDeferred();
      const releaseScan = createDeferred();
      const admit = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
      let initialPass: Promise<unknown> | undefined;
      const admissionSpy = vi
        .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
        .mockImplementation(
          <T>(run: () => Promise<T>, origin?: string, signal?: AbortSignal): Promise<T> => {
            const pass = admit(run, origin, signal);
            if (origin !== "main-session:startup-recovery" || initialPass) {
              return pass;
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
        gatewayRuntime,
        getConfig: () => ({}),
        delayMs: 0,
        stateDir: tmpDir,
      });
      try {
        await scanned.promise;
        expect(callGateway).not.toHaveBeenCalled();
        if (publication !== "during the initial scan") {
          releaseScan.resolve();
          await initialPass;
        }
        if (publication === "after stop") {
          await recovery.stop();
        }
        await preparePendingAgentDatabase(refusal, { env, assertCurrent() {} }, async () => {});
        releaseScan.resolve();
        if (publication === "after stop") {
          await recovery.stop();
          expect(callGateway).not.toHaveBeenCalled();
        } else {
          await gatewayRuntime.expectAdmission(1, recovery, {
            sessionKey: "agent:main:main",
            storePath,
          });
        }
      } finally {
        releaseScan.resolve();
        await recovery.stop();
        admissionSpy.mockRestore();
        recordAgentDatabaseAdmissions([], { env });
      }
    },
  );

  it("repairs a mixed restart roster without abandoning main recovery or live work", async () => {
    const {
      tmpDir,
      makeSessionsDir,
      writeStore,
      writeTranscript,
      runningSessionEntry,
      makePendingFinalDelivery,
      readStore,
      gatewayRuntime,
      dispatchSettlement,
    } = getFixture();
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: tmpDir, OPENCLAW_CONFIG_PATH: path.join(tmpDir, "openclaw.json") },
      async () => {
        const cfg = { agents: { entries: { main: {} } } } satisfies OpenClawConfig;
        const sessionsDir = await makeSessionsDir();
        const storePath = path.join(sessionsDir, "sessions.json");
        const predecessorAt = Math.floor(performance.timeOrigin) - 1_000;
        const fixture: Record<string, SessionEntry> = {};
        const addRows = (
          group: string,
          count: number,
          entry: (index: number) => Partial<SessionEntry>,
        ) =>
          Array.from({ length: count }, (_, index) => {
            const sessionKey = `agent:main:${group === "live" && index === 4 ? "subagent" : "dashboard"}:${group}-${index}`;
            fixture[sessionKey] = runningSessionEntry(`${group}-${index}`, {
              lifecycleRevision: `${group}-${index}-revision`,
              lifecycleRunId: `${group}-${index}-old-run`,
              startedAt: predecessorAt,
              updatedAt: predecessorAt,
              ...entry(index),
            });
            return sessionKey;
          });
        const archivedKeys = addRows("archived", 16, (index) => ({
          archivedAt: predecessorAt,
          abortedLastRun: true,
          ...(index === 14 ? { startedAt: undefined } : {}),
          ...(index === 15
            ? { spawnDepth: 1, restartRecoveryForceSafeTools: true }
            : {
                mainRestartRecovery: {
                  cycleId: `archived-cycle-${index}`,
                  revision: 1,
                  chargedAttempts: 0,
                },
              }),
          ...(index === 0 ? { pendingFinalDelivery: makePendingFinalDelivery() } : {}),
        }));
        const spawnedKeys = addRows("spawned", 4, (index) => ({
          spawnDepth: 1,
          ...(index === 3 ? { abortedLastRun: true, restartRecoveryForceSafeTools: true } : {}),
        }));
        const recoverableKeys = addRows("recoverable", 4, (index) => ({
          spawnDepth: 0,
          abortedLastRun: true,
          restartRecoveryForceSafeTools: true,
          ...(index < 3
            ? {
                mainRestartRecovery: {
                  cycleId: `recoverable-cycle-${index}`,
                  revision: 1,
                  chargedAttempts: 0,
                },
              }
            : {}),
        }));
        const liveKeys = addRows("live", 5, (index) =>
          index === 4
            ? { spawnDepth: 1 }
            : index === 0
              ? {
                  archivedAt: predecessorAt,
                  abortedLastRun: true,
                  mainRestartRecovery: {
                    cycleId: "live-archived-cycle",
                    revision: 1,
                    chargedAttempts: 0,
                  },
                  pendingFinalDelivery: makePendingFinalDelivery(),
                }
              : {},
        );
        const activeRunIds: string[] = [];
        const registerLive = (sessionKey: string, runId: string) => {
          activeRunIds.push(runId);
          registerAgentRunContext(runId, {
            sessionKey,
            sessionId: fixture[sessionKey]!.sessionId,
            projectSessionActive: true,
          });
        };
        const inactiveRunning = (store: Record<string, SessionEntry>) =>
          Object.entries(store).filter(
            ([sessionKey, entry]) =>
              entry.status === "running" &&
              !listAgentRunsForSession({ sessionKey, sessionId: entry.sessionId }).some(
                ({ runId }) => hasLiveAgentRunContext(runId),
              ),
          ).length;
        // This lock supplies real startup ownership without starting a network listener.
        const lock = await acquireGatewayLock({
          allowInTests: true,
          port: 24123,
          listenerMode: "foreground",
        });
        expect(lock).toBeDefined();
        if (!lock) {
          throw new Error("expected isolated Gateway ownership");
        }
        try {
          await lock.run(async () => {
            await writeStore(sessionsDir, fixture);
            saveSubagentRegistryToSqlite(
              new Map(
                [0, 1].map((index) => {
                  const runId = `completed-child-${index}`;
                  return [
                    runId,
                    createSubagentRunRecord({
                      runId,
                      childSessionKey: `agent:main:subagent:${runId}`,
                      requesterSessionKey: spawnedKeys[0]!,
                      createdAt: predecessorAt - 1,
                      endedAt: predecessorAt,
                      outcome: { status: "ok" },
                      expectsCompletionMessage: true,
                      delivery: { status: "delivered", deliveredAt: predecessorAt },
                      cleanupCompletedAt: predecessorAt,
                    }),
                  ];
                }),
              ),
            );
            const childHistory = loadSubagentRegistryFromSqlite();
            for (const sessionKey of recoverableKeys) {
              await writeTranscript(sessionsDir, fixture[sessionKey]!.sessionId, [
                { role: "user", content: "continue the interrupted task" },
              ]);
            }
            for (const sessionKey of liveKeys) {
              registerLive(sessionKey, `${fixture[sessionKey]!.sessionId}-current-run`);
            }
            const before = readStore(storePath);
            expect(inactiveRunning(before)).toBe(24);
            vi.mocked(callGateway).mockImplementation(async (call) => {
              const request = expectRecord(call.params, "recovery dispatch");
              expect(call.method).toBe("agent");
              expect(recoverableKeys).toContain(request.sessionKey);
              if (
                typeof request.sessionKey !== "string" ||
                typeof request.idempotencyKey !== "string"
              ) {
                throw new Error("expected an exact recovery session and run");
              }
              registerLive(request.sessionKey, request.idempotencyKey);
              return { runId: request.idempotencyKey };
            });
            const log = { info: vi.fn(), warn: vi.fn() };
            await runStartupSessionMaintenanceForTest({ cfg, log });
            const activeSessionIds = liveKeys.map((sessionKey) => fixture[sessionKey]!.sessionId);
            await markStartupOrphanedMainSessionsForRecovery({
              cfg,
              stateDir: tmpDir,
              activeSessionIds,
            });
            await expect(
              recoverRestartAbortedMainSessions({
                cfg,
                stateDir: tmpDir,
                activeSessionIds,
                gatewayRuntime,
              }),
            ).resolves.toMatchObject({ started: 4, settled: 0, failed: 0 });
            const after = readStore(storePath);
            expect(inactiveRunning(after)).toBe(0);
            expect(callGateway).toHaveBeenCalledTimes(4);
            expect(log.warn).not.toHaveBeenCalled();
            expect(loadSubagentRegistryFromSqlite()).toEqual(childHistory);
            for (const sessionKey of archivedKeys) {
              expect(after[sessionKey]).toMatchObject({ status: "killed" });
              expect(after[sessionKey]?.mainRestartRecovery).toEqual(
                before[sessionKey]?.mainRestartRecovery,
              );
              expect(after[sessionKey]?.pendingFinalDelivery).toEqual(
                before[sessionKey]?.pendingFinalDelivery,
              );
              expect(after[sessionKey]?.startedAt).toBe(before[sessionKey]?.startedAt);
              expect(after[sessionKey]?.runtimeMs).toBe(before[sessionKey]?.runtimeMs);
              expect(after[sessionKey]?.lifecycleRunId).toBeUndefined();
              expect(
                await loadTranscriptEvents({
                  agentId: "main",
                  sessionKey,
                  sessionId: fixture[sessionKey]!.sessionId,
                  storePath,
                }),
              ).toEqual([]);
            }
            for (const sessionKey of spawnedKeys) {
              expect(after[sessionKey]).toMatchObject({
                status: "interrupted",
                abortedLastRun: true,
              });
            }
            for (const sessionKey of recoverableKeys) {
              expect(after[sessionKey]).toMatchObject({ status: "running", abortedLastRun: false });
            }
            for (const sessionKey of liveKeys) {
              expect(after[sessionKey]).toEqual(before[sessionKey]);
            }
          });
        } finally {
          dispatchSettlement.resolve();
          for (const runId of activeRunIds) {
            clearAgentRunContext(runId);
          }
          await cleanupSessionStateForTest({ stateDir: tmpDir });
          await lock.release();
        }
      },
    );
  });

  it("does not dispatch an archived durable recovery claim", async () => {
    const { makeSessionsDir, writeStore, writeTranscript, expectRecovery } = getFixture();
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "archived-session",
        updatedAt: Date.now() - 10_000,
        archivedAt: Date.now() - 5_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "archived-recovery",
        restartRecoveryDeliverySourceRunId: "archived-source",
      },
    });
    await writeTranscript(sessionsDir, "archived-session", [
      { role: "user", content: "do not recover while archived" },
    ]);

    await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
  });
}
