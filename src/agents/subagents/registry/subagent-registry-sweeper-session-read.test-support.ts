import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { executeExistingOpenClawStateRead } from "../../../state/openclaw-state-db-readonly.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createEnteredGate } from "../../entered-gate.test-support.js";
import { resolveSubagentSessionAttachmentRootDir } from "../subagent-attachment-paths.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import {
  createArchivedSubagentSweeperRun as archivedRun,
  createSubagentSweeperHarness as createHarness,
} from "./subagent-registry-sweeper.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";

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

export function registerSubagentSweepRetainedAuthorityTests(killSessionEntry: {
  current: Awaited<ReturnType<typeof loadSubagentSessionEntry>>;
}) {
  it("retains an unresolved child owner before cleanup", async () => {
    const harness = createHarness(
      archivedRun({ childSessionKey: "global", childAgentId: undefined }),
    );
    const before = structuredClone(harness.runs);

    await harness.sweeper.sweepOnce();
    await harness.sweeper.sweepOnce();

    expect(harness.runs).toEqual(before);
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
        const harness = createHarness(entry);
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
      const { sweeper, callGateway, runs } = createHarness(entry);
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
