import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import * as sessionEntryReads from "../../../config/sessions/session-entry-read-runtime.js";
import { createMockGatewayRecoveryRuntime } from "../../../gateway/server-recovery-runtime.test-support.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { executeExistingOpenClawStateRead } from "../../../state/openclaw-state-db-readonly.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createEnteredGate } from "../../entered-gate.test-support.js";
import { resolveSubagentSessionAttachmentRootDir } from "../subagent-attachment-paths.js";
import { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { subagentRegistryLog } from "./subagent-registry-lifecycle-log.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import {
  createArchivedSubagentSweeperRun as archivedRun,
  createSubagentSweeperHarness as createHarness,
} from "./subagent-registry-sweeper.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  loadSubagentSessionEntry,
  resolveSubagentRunOrphanReason,
} from "./subagent-session-reconciliation.js";

export function persistRuns(
  runs: Map<string, SubagentRunRecord>,
  rows: [string, SubagentRunRecord | null][],
) {
  return mutateSubagentRuns(
    rows.map(([id]) => id),
    () => ({ value: undefined, postimages: new Map(rows) }),
    { runs },
  );
}

export async function readPersistedRuns(env: NodeJS.ProcessEnv, runIds: string[]) {
  const result = await executeExistingOpenClawStateRead(
    { env },
    { type: "subagents.runs", scope: { kind: "ids", runIds } },
  );
  if (!result?.ok || result.type !== "subagents.runs" || result.projection) {
    throw new Error("Fixture could not read durable runs");
  }
  return result.runs;
}

export function createSweepGate() {
  const gate = createEnteredGate();
  return {
    wait: gate.wait,
    async check(
      sweeper: ReturnType<typeof createHarness>["sweeper"],
      check: (finish: () => Promise<void>) => Promise<void>,
    ) {
      const pending = sweeper.sweepOnce();
      const finish = async () => {
        gate.release();
        await pending;
      };
      try {
        await awaitGateBeforeSettlement(gate.entered, pending, "Sweep skipped its held operation");
        await check(finish);
      } finally {
        await finish();
        await sweeper.reset();
      }
    },
  };
}

export function withSweeperSessionState(check: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({
      session: { store: state.statePath("agents/{agentId}/sessions/sessions.json") },
    });
    await check(state);
  });
}

export async function withRealSessionReads(check: (state: OpenClawTestState) => Promise<void>) {
  const actual = await vi.importActual<typeof import("./subagent-session-reconciliation.js")>(
    "./subagent-session-reconciliation.js",
  );
  await vi
    .mocked(loadSubagentSessionEntry)
    .withImplementation(actual.loadSubagentSessionEntry, () => withSweeperSessionState(check));
}

export function registerSubagentSweepRetainedAuthorityTests(
  recoverRow: ReturnType<typeof vi.fn>,
  killSessionEntry: { current: Awaited<ReturnType<typeof loadSubagentSessionEntry>> },
) {
  it("retains an unresolved child owner before recovery or cleanup", async () => {
    recoverRow.mockResolvedValue({ status: "ignored" });
    const harness = createHarness(
      {},
      archivedRun({ childSessionKey: "global", childAgentId: undefined }),
    );
    const before = structuredClone(harness.runs);

    await harness.sweeper.sweepOnce();
    await harness.sweeper.sweepOnce();

    expect(harness.runs).toEqual(before);
    expect(recoverRow).not.toHaveBeenCalled();
    expect(harness.callGateway).not.toHaveBeenCalled();
    expect(harness.completeSubagentRunWithRecovery).not.toHaveBeenCalled();
    expect(harness.completeCleanupBookkeeping).not.toHaveBeenCalled();
    expect(harness.notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "archive", missing: undefined, suppressed: true },
    { kind: "collector", missing: undefined, suppressed: true },
    { kind: "collector launch", missing: undefined, suppressed: true },
    { kind: "collector launch", missing: "owner", suppressed: true },
    { kind: "collector launch", missing: "incarnation", suppressed: true },
    { kind: "collector launch", missing: "revision", suppressed: false },
    { kind: "collector launch", missing: "revision", suppressed: true },
  ] as const)(
    "settles durable $kind artifacts only with retained authority (missing: $missing, suppressed: $suppressed)",
    async ({ kind, missing, suppressed }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const now = Date.now();
        const launch = kind === "collector launch";
        const attachmentId = randomUUID();
        const entry = archivedRun({
          childSessionKey: "global",
          childAgentId: missing === "owner" ? undefined : "main",
          childSessionIdentity:
            missing === "incarnation"
              ? undefined
              : {
                  sessionId: "original-session",
                  lifecycleRevision: missing === "revision" ? undefined : "original-revision",
                },
          attachmentId,
          archiveAtMs: launch ? now + 1 : now - 1,
          ...(kind !== "archive"
            ? { collect: true, groupId: "artifact-group", collectorCompletion: { status: "done" } }
            : {}),
          collectorLaunchCleanupPending: launch,
        });
        entry.execution.suppressSessionEffects = suppressed ? true : undefined;
        const harness = createHarness({}, entry);
        vi.mocked(stateWorker.runOpenClawStateWorkerOperation).mockRestore();
        harness.runs.clear();
        await persistRuns(harness.runs, [[entry.runId, entry]]);
        const attachmentRoot = resolveSubagentSessionAttachmentRootDir({
          agentId: "main",
          childSessionKey: entry.childSessionKey,
        });
        const attachmentDir = path.join(attachmentRoot, attachmentId);
        const siblingDir = path.join(attachmentRoot, randomUUID());
        await fs.mkdir(attachmentDir, { recursive: true });
        await fs.mkdir(siblingDir, { recursive: true });
        await fs.writeFile(path.join(attachmentDir, "artifact.txt"), "retained child artifact");
        const readPersisted = async () =>
          (await readPersistedRuns(state.env, [entry.runId])).get(entry.runId);
        const before = await readPersisted();
        expect(before).toMatchObject({ runId: entry.runId, attachmentId });
        const shouldRetire = missing !== "owner";
        try {
          await harness.sweeper.sweepOnce();
          if (launch && shouldRetire) {
            expect(await readPersisted()).toMatchObject({
              collectorLaunchCleanupPending: false,
              cleanupCompletedAt: now,
              execution: { suppressSessionEffects: true },
            });
            await fs.access(attachmentDir);
          }
          vi.setSystemTime(now + 2);
          await harness.sweeper.sweepOnce();
          await harness.sweeper.sweepOnce();
          expect(harness.callGateway).not.toHaveBeenCalled();
          expect(harness.notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
          expect(harness.runContextEngineSubagentEnded).not.toHaveBeenCalled();
          expect(harness.runs.has(entry.runId)).toBe(!shouldRetire);
          if (shouldRetire) {
            expect(await readPersisted()).toBeUndefined();
            await expect(fs.access(attachmentDir)).rejects.toHaveProperty("code", "ENOENT");
          } else {
            expect(await readPersisted()).toEqual(before);
            await expect(
              fs.readFile(path.join(attachmentDir, "artifact.txt"), "utf8"),
            ).resolves.toBe("retained child artifact");
          }
          await fs.access(siblingDir);
        } finally {
          await harness.sweeper.reset();
        }
      });
    },
  );
  it.each([false, true])(
    "archives only the recorded owner and original incarnation of a raw child (browser cleanup dispatched: %s)",
    async (browserCleanupDispatched) => {
      const entry = archivedRun({
        childSessionKey: "global",
        childAgentId: "worker",
        browserCleanupDispatchedAt: browserCleanupDispatched ? Date.now() - 1 : undefined,
      });
      const { sweeper, callGateway, runs } = createHarness({}, entry);
      killSessionEntry.current = {
        sessionId: "replacement-session",
        lifecycleRevision: "replacement-revision",
        updatedAt: Date.now(),
      };

      await sweeper.sweepOnce();

      expect(callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "sessions.delete",
          params: expect.objectContaining({
            key: "global",
            agentId: "worker",
            expectedSessionId: "session-id",
            expectedLifecycleRevision: "session-revision",
          }),
        }),
      );
      expect(runs.has(entry.runId)).toBe(false);
    },
  );
}

export function registerSubagentSweeperSessionReadTests(ignoreRecovery: () => void) {
  it("classifies orphanhood and completion from the same worker snapshot during a session rewrite", async () => {
    await withRealSessionReads(async (state) => {
      ignoreRecovery();
      const { entry, completeSubagentRunWithRecovery, sweeper } = createHarness({});
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:read-source", env: state.env },
        { sessionId: "read-source", updatedAt: Date.now() },
      );
      const gate = createSweepGate();
      const readEntry = sessionEntryReads.readSessionEntryReadOnlyInWorker;
      let held = false;
      using read = vi.spyOn(sessionEntryReads, "readSessionEntryReadOnlyInWorker");
      read.mockImplementation(async (...args) => {
        const snapshot = await readEntry(...args);
        if (!held && args[0].sessionKey === entry.childSessionKey) {
          held = true;
          expect(snapshot).toBeUndefined();
          await gate.wait();
        }
        return snapshot;
      });
      await gate.check(sweeper, async (finish) => {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: entry.childSessionKey, env: state.env },
          {
            sessionId: "rewritten-session",
            updatedAt: Date.now(),
            startedAt: entry.execution.startedAt,
            endedAt: Date.now(),
            status: "done",
          },
        );
        await finish();
        expect(completeSubagentRunWithRecovery).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            runId: entry.runId,
            expectedEntry: entry,
            outcome: { status: "error", error: "subagent run orphaned: missing-session-entry" },
          }),
          "sweeper-lost-context",
        );
        expect(
          loadSessionEntryReadOnly({
            agentId: "main",
            sessionKey: entry.childSessionKey,
            env: state.env,
          })?.sessionId,
        ).toBe("rewritten-session");
      });
    });
  });

  it("does not manufacture terminal completion when the child worker read rejects", async () => {
    await withRealSessionReads(async (state) => {
      ignoreRecovery();
      const { entry, runs, completeSubagentRunWithRecovery, sweeper } = createHarness({});
      const scope = {
        agentId: "main",
        sessionKey: entry.childSessionKey,
        storePath: state.statePath("agents/main/sessions/sessions.json"),
        env: state.env,
      };
      replaceSessionEntrySync(scope, { sessionId: "invalid-child", updatedAt: Date.now() });
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ?, entry_valid = 0 WHERE session_key = ?")
        .run('{"bad":true}', entry.childSessionKey);
      try {
        await expect(sweeper.sweepOnce()).rejects.toThrow(
          "invalid persisted session row requires repair",
        );
        expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();
        expect(runs.get(entry.runId)).toBe(entry);
        expect(entry.execution.endedAt).toBeUndefined();
      } finally {
        await sweeper.reset();
      }
    });
  });
}

export function registerSubagentSweepCompletionRecoveryTests(ignoreRecovery: () => void) {
  it.each(["lifecycle", "runtime"] as const)(
    "keeps completion retries with the sweep's original Gateway %s",
    async (change) => {
      await vi.mocked(resolveSubagentRunOrphanReason).withImplementation(
        () => null,
        async () => {
          ignoreRecovery();
          const gateway = { current: createMockGatewayRecoveryRuntime() };
          const h = createHarness(gateway);
          const gate = createSweepGate();
          const attempt = vi.fn(async () => {
            await gate.wait();
            throw new Error("completion rejected during Gateway retirement");
          });
          const scheduleSweep = vi.fn();
          const resumeRun = vi.fn();
          using _ = vi.spyOn(subagentRegistryLog, "warn").mockImplementation(() => {});
          const completion = createSubagentRegistryCompletionRuntime({
            runs: h.runs,
            resumed: new Set(),
            retryTimers: new Set(),
            completeSubagentRun: attempt,
            scheduleSweep,
            resumeRun,
          });
          h.completeSubagentRunWithRecovery.mockImplementation(
            completion.completeSubagentRunWithRecovery,
          );
          await gate.check(h.sweeper, async (finish) => {
            if (change === "lifecycle") {
              rotateAgentEventLifecycleGeneration();
            } else {
              gateway.current = createMockGatewayRecoveryRuntime();
            }
            await finish();
            expect(attempt).toHaveBeenCalledOnce();
            expect(scheduleSweep).not.toHaveBeenCalled();
            expect(resumeRun).not.toHaveBeenCalled();
            expect(h.runs.get(h.entry.runId)).toBe(h.entry);
            expect(h.entry.execution.endedAt).toBeUndefined();
          });
        },
      );
    },
  );
}
