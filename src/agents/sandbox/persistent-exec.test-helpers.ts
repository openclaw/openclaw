import { expect } from "vitest";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { upsertCronJobRow } from "../../cron/store/row-codec.js";
import { makeCronStreamSandboxTarget } from "../../cron/stream-sandbox.test-support.js";
import { cronStreamScheduleKey } from "../../cron/stream-schedule.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { createSandboxPersistentExecStore } from "./persistent-exec-store.js";
import type {
  SandboxPersistentExecMutationResult,
  SandboxPersistentExecRecord,
  SandboxPersistentExecReservation,
} from "./persistent-exec-store.types.js";
import type { DockerPersistentExecReceipt } from "./persistent-exec.types.js";

type Store = ReturnType<typeof createSandboxPersistentExecStore>;

export const reservation: SandboxPersistentExecReservation = {
  ownerKey: "cron:fixture:job-a",
  sourceIdentity: "source-a",
  attemptId: "00000000-0000-4000-8000-000000000001",
  backendId: "docker",
  backendTarget: {
    kind: "docker",
    endpoint: "unix:///var/run/docker.sock",
    daemonId: "fixture-daemon",
  },
  containerId: "a".repeat(64),
  containerName: "fixture-container",
  containerStartedAt: "2026-01-01T00:00:00.000Z",
};

export function reservationFor(attempt: number, sourceIdentity = reservation.sourceIdentity) {
  const attemptId = `00000000-0000-4000-8000-${String(attempt).padStart(12, "0")}`;
  return { ...reservation, sourceIdentity, attemptId };
}
export const registryEntry = {
  containerName: reservation.containerName,
  backendId: "docker",
  sessionKey: "agent:main",
  image: "fixture:image",
  createdAtMs: 1,
  lastUsedAtMs: 1,
  workspaceDir: "/fixture/workspace",
};
export const receipt: DockerPersistentExecReceipt = {
  version: 1,
  target: reservation.backendTarget,
  attemptId: reservation.attemptId,
  parentContainerId: reservation.containerId,
  containerId: "b".repeat(64),
};

export function retained(result: SandboxPersistentExecMutationResult): SandboxPersistentExecRecord {
  expect(result.ok).toBe(true);
  if (!result.ok || !result.current) {
    throw new Error("Expected retained custody");
  }
  return result.current;
}

export function expected(record: SandboxPersistentExecRecord) {
  return {
    ownerKey: record.ownerKey,
    attemptId: record.attemptId,
    expectedRevision: record.revision,
  };
}

export function custodyTransitions(
  store: Store,
  assertCurrent?: () => void,
  source?: Parameters<Store["transition"]>[2],
) {
  return async (
    record: SandboxPersistentExecRecord,
    phase: "prepared" | "running",
    proof?: DockerPersistentExecReceipt,
  ) =>
    retained(
      await store.transition({ ...expected(record), phase, receipt: proof }, assertCurrent, source),
    );
}

export function setProcessOwner(
  record: SandboxPersistentExecRecord,
  owner: SandboxPersistentExecRecord["owner"],
) {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .updateTable("sandbox_persistent_execs")
        .set({ owner_json: JSON.stringify({ owner }) })
        .where("owner_key", "=", record.ownerKey),
    );
  });
}

export function createStreamSource(storeKey: string) {
  const job = {
    ...makeCronJob({ state: { streamSourceIdentity: reservation.sourceIdentity } }),
    schedule: { kind: "stream" as const, command: ["fixture-watcher"] },
    streamSandbox: makeCronStreamSandboxTarget(),
  };
  const source = {
    storeKey,
    jobId: job.id,
    sourceIdentity: reservation.sourceIdentity,
    scheduleKey: cronStreamScheduleKey(job.schedule, job.streamSandbox),
  };
  const persist = () =>
    runOpenClawStateWriteTransaction(({ db }) => {
      upsertCronJobRow(db, source.storeKey, job, 0);
    });
  persist();
  return { job, source, persist };
}
