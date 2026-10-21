import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { upsertCronJobRow } from "../../cron/store/row-codec.js";
import { makeCronStreamSandboxTarget } from "../../cron/stream-sandbox.test-support.js";
import { cronStreamScheduleKey } from "../../cron/stream-schedule.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import * as containerEngine from "./container-engine.js";
import { stopDockerPersistentExec } from "./docker-persistent-exec.js";
import { createSandboxPersistentExecStore } from "./persistent-exec-store.js";
import type {
  SandboxPersistentExecMutationResult,
  SandboxPersistentExecRecord,
  SandboxPersistentExecReservation,
} from "./persistent-exec-store.types.js";
import type { DockerPersistentExecReceipt } from "./persistent-exec.types.js";
import { removeRegistryEntry, updateRegistry } from "./registry.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

async function fixture(initializeRegistry = true) {
  const root = tempDirs.make("openclaw-sandbox-custody-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  if (initializeRegistry) {
    await updateRegistry(registryEntry);
  }
  vi.spyOn(containerEngine, "execContainer").mockImplementation(async (_engine, args) => {
    if (args[0] === "info") {
      return { code: 0, stdout: reservation.backendTarget.daemonId, stderr: "" };
    }
    if (args[0] === "inspect") {
      return { code: 1, stdout: "", stderr: `Error: No such object: ${args.at(-1)}` };
    }
    throw new Error(`Unexpected Docker operation: ${args[0]}`);
  });
  return {
    store: createSandboxPersistentExecStore(),
    databasePath: path.join(root, "state", "openclaw.sqlite"),
  };
}

const reservation: SandboxPersistentExecReservation = {
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
const registryEntry = {
  containerName: reservation.containerName,
  backendId: "docker",
  sessionKey: "agent:main",
  image: "fixture:image",
  createdAtMs: 1,
  lastUsedAtMs: 1,
  workspaceDir: "/fixture/workspace",
};
const receipt: DockerPersistentExecReceipt = {
  version: 1,
  target: reservation.backendTarget,
  attemptId: reservation.attemptId,
  parentContainerId: reservation.containerId,
  containerId: "b".repeat(64),
};
const assertCurrent = () => {};
function accepted(result: SandboxPersistentExecMutationResult): SandboxPersistentExecRecord {
  expect(result.ok).toBe(true);
  if (!result.ok || !result.current) {
    throw new Error("Expected retained custody");
  }
  return result.current;
}
function expected(record: SandboxPersistentExecRecord) {
  return {
    ownerKey: record.ownerKey,
    attemptId: record.attemptId,
    expectedRevision: record.revision,
  };
}

async function confirmStopped(
  store: ReturnType<typeof createSandboxPersistentExecStore>,
  record: SandboxPersistentExecRecord,
) {
  const stopped = await stopDockerPersistentExec(
    record.receipt ?? {
      target: record.backendTarget,
      attemptId: record.attemptId,
      parentContainerId: record.containerId,
    },
  );
  return await store.confirmContainerExtinction(expected(record), stopped.extinction);
}

it("keeps unused custody reads noncreating, including an existing database without the feature", async () => {
  const { store, databasePath } = await fixture(false);
  expect(await store.list()).toEqual([]);
  expect(fs.existsSync(databasePath)).toBe(false);
  const { db } = openOpenClawStateDatabase();
  expect(await store.list({ ownerKey: reservation.ownerKey })).toEqual([]);
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE name = 'sandbox_persistent_execs'").all(),
  ).toEqual([]);
  expect(db.prepare("PRAGMA user_version").get()).toEqual({
    user_version: OPENCLAW_STATE_SCHEMA_VERSION,
  });
});

it("serializes reservation, rejects stale effects and releases only durably confirmed cleanup off the host thread", async () => {
  const { store } = await fixture();
  const competing = createSandboxPersistentExecStore();
  const [first, second] = await Promise.all([
    store.reserve(reservation, assertCurrent),
    competing.reserve(
      {
        ...reservation,
        sourceIdentity: "replacement",
        attemptId: "00000000-0000-4000-8000-000000000002",
      },
      assertCurrent,
    ),
  ]);
  expect(Number(first.ok) + Number(second.ok)).toBe(1);
  const writer = first.ok ? store : competing;
  const other = first.ok ? competing : store;
  const reserved = accepted(first.ok ? first : second);
  const activeReceipt = { ...receipt, attemptId: reserved.attemptId };
  expect(first.ok ? second : first).toEqual({ ok: false, current: reserved });
  await writer.list();
  requireNodeSqlite();
  const hostSql = observeMainThreadSql();
  const prepared = accepted(
    await writer.transition(
      { ...expected(reserved), phase: "prepared", receipt: activeReceipt },
      assertCurrent,
    ),
  );
  expect(
    await writer.transition({ ...expected(reserved), phase: "running" }, assertCurrent),
  ).toEqual({ ok: false, current: prepared });
  expect(await other.transition({ ...expected(prepared), phase: "stopping" })).toEqual({
    ok: false,
    current: prepared,
  });
  await expect(
    writer.transition(
      {
        ...expected(prepared),
        phase: "running",
        receipt: { ...activeReceipt, containerId: "c".repeat(64) },
      },
      assertCurrent,
    ),
  ).rejects.toThrow("stream container identity changed");
  const running = accepted(
    await writer.transition({ ...expected(prepared), phase: "running" }, assertCurrent),
  );
  const uncertain = accepted(
    await writer.transition({
      ...expected(running),
      phase: "uncertain",
      error: "cleanup unavailable",
    }),
  );
  await expect(writer.removeConfirmed(expected(uncertain))).rejects.toThrow(
    "cleanup has not been confirmed",
  );
  expect(
    await writer.reserve(
      {
        ...reservation,
        sourceIdentity: "new-source",
        attemptId: "00000000-0000-4000-8000-000000000003",
      },
      assertCurrent,
    ),
  ).toEqual({ ok: false, current: uncertain });
  await expect(writer.transition({ ...expected(uncertain), phase: "stopped" })).rejects.toThrow(
    "Invalid persistent sandbox custody transition",
  );
  const stopped = accepted(await confirmStopped(writer, uncertain));
  await expect(writer.assertCustodyCurrent(prepared)).resolves.toBeUndefined();
  expect(await writer.list({ containerId: reservation.containerId })).toEqual([stopped]);
  expect(await writer.list({ containerName: reservation.containerName })).toEqual([stopped]);
  expect(
    await writer.removeConfirmed(expected(stopped), { requireWorkspaceBinding: true }),
  ).toEqual({ ok: true, current: null });
  await expect(writer.assertCustodyCurrent(prepared)).rejects.toThrow("workspace custody changed");
  const successor = accepted(
    await writer.reserve(
      { ...reservation, attemptId: "00000000-0000-4000-8000-000000000004" },
      assertCurrent,
    ),
  );
  await expect(writer.assertCustodyCurrent(prepared)).rejects.toThrow("workspace custody changed");
  expect(await writer.removeConfirmed(expected(stopped))).toEqual({
    ok: false,
    current: successor,
  });
  expect(hostSql.count()).toBe(0);
});

it("checks the canonical cron source before admission and during execution without blocking cleanup of retired intent", async () => {
  const { store, databasePath } = await fixture();
  const job = {
    ...makeCronJob({
      state: { streamSourceIdentity: reservation.sourceIdentity },
    }),
    schedule: { kind: "stream" as const, command: ["fixture-watcher"] },
    streamSandbox: makeCronStreamSandboxTarget(),
  };
  const source = {
    storeKey: path.join(databasePath, "fixture-cron"),
    jobId: job.id,
    sourceIdentity: reservation.sourceIdentity,
    scheduleKey: cronStreamScheduleKey(job.schedule, job.streamSandbox),
  };
  const persist = () =>
    runOpenClawStateWriteTransaction(({ db }) => {
      upsertCronJobRow(db, source.storeKey, job, 0);
    });
  persist();
  const reserved = accepted(await store.reserve(reservation, assertCurrent, source));
  const prepared = accepted(
    await store.transition(
      { ...expected(reserved), phase: "prepared", receipt },
      assertCurrent,
      source,
    ),
  );
  const running = accepted(
    await store.transition({ ...expected(prepared), phase: "running" }, assertCurrent, source),
  );
  expect(await store.checkExecutionCurrent(expected(running), source, assertCurrent)).toEqual({
    ok: true,
    current: running,
  });
  await removeRegistryEntry(registryEntry.containerName);
  await updateRegistry({
    ...registryEntry,
    workspaceDir: "/fixture/replacement",
    createdAtMs: registryEntry.createdAtMs + 1,
  });
  await expect(
    store.checkExecutionCurrent(expected(running), source, assertCurrent),
  ).rejects.toThrow("workspace binding changed");
  const stopping = accepted(await store.transition({ ...expected(running), phase: "stopping" }));
  job.enabled = false;
  persist();
  await expect(
    store.checkExecutionCurrent(expected(stopping), source, assertCurrent),
  ).rejects.toThrow("no longer authorized");
  const stopped = accepted(await confirmStopped(store, stopping));
  await expect(
    store.removeConfirmed(expected(stopped), { requireWorkspaceBinding: true }),
  ).rejects.toThrow("workspace binding changed");
  expect(await store.list()).toEqual([stopped]);
  await store.removeConfirmed(expected(stopped));
  await expect(
    store.reserve(
      { ...reservation, attemptId: "00000000-0000-4000-8000-000000000005" },
      assertCurrent,
      source,
    ),
  ).rejects.toThrow("no longer authorized");
  expect(await store.list()).toEqual([]);
});

it("retains cleanup through registry writes and deletion, then reopens without a version bump", async () => {
  const { store } = await fixture();
  const reserved = accepted(await store.reserve(reservation, assertCurrent));
  const prepared = accepted(
    await store.transition({ ...expected(reserved), phase: "prepared", receipt }, assertCurrent),
  );
  const entry = {
    containerName: reservation.containerName,
    backendId: "docker",
    sessionKey: "agent:main",
    image: "fixture:image",
    createdAtMs: 1,
    lastUsedAtMs: 1,
  };
  await updateRegistry(entry);
  await updateRegistry({ ...entry, lastUsedAtMs: 2 });
  await removeRegistryEntry(entry.containerName);
  expect(await store.list({ sourceIdentity: reservation.sourceIdentity })).toEqual([prepared]);
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-unrelated-custody-"));
  expect(await createSandboxPersistentExecStore({ env: store.environment }).list()).toEqual([
    prepared,
  ]);
  const { db } = openOpenClawStateDatabase({ env: store.environment });
  expect(db.prepare("PRAGMA user_version").get()).toEqual({
    user_version: OPENCLAW_STATE_SCHEMA_VERSION,
  });
  expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("refuses launch after registry removal intent while retaining cleanup authority", async () => {
  const { store } = await fixture();
  const reserved = accepted(await store.reserve(reservation, assertCurrent));
  await updateRegistry({ ...registryEntry, runtimeState: "removing" });
  await expect(
    store.transition({ ...expected(reserved), phase: "prepared", receipt }, assertCurrent),
  ).rejects.toThrow("being removed");
  const stopped = accepted(await confirmStopped(store, reserved));
  await store.removeConfirmed(expected(stopped));
  await expect(
    store.reserve(
      { ...reservation, attemptId: "00000000-0000-4000-8000-000000000005" },
      assertCurrent,
    ),
  ).rejects.toThrow("being removed");
  expect(await store.list()).toEqual([]);
});

it.each([
  "reused PID",
  ...(process.platform === "linux" || process.platform === "darwin" ? ["previous boot"] : []),
])("recovers a %s owner only toward original-daemon cleanup", async (cause) => {
  const { store } = await fixture();
  const reserved = accepted(await store.reserve(reservation, assertCurrent));
  const prepared = accepted(
    await store.transition({ ...expected(reserved), phase: "prepared", receipt }, assertCurrent),
  );
  const recovery = createSandboxPersistentExecStore();
  await expect(
    recovery.confirmContainerExtinction(expected(prepared), {
      kind: "docker-container-extinction",
    }),
  ).rejects.toThrow("not confirmed by its original Docker custody owner");
  const unrelated = await stopDockerPersistentExec({ ...receipt, containerId: "c".repeat(64) });
  await expect(
    recovery.confirmContainerExtinction(expected(prepared), unrelated.extinction),
  ).rejects.toThrow("differs from the retained container generation");
  expect(await recovery.list()).toEqual([prepared]);
  expect(await recovery.claimRecovery(expected(prepared))).toEqual({
    ok: false,
    current: prepared,
  });
  expect(prepared.owner.namespace).toBeTruthy();
  expect(prepared.owner.startedAt).not.toBeNull();
  const stale = { ...prepared.owner, startedAt: prepared.owner.startedAt! + 1 };
  const setOwner = (owner: SandboxPersistentExecRecord["owner"]) =>
    runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("sandbox_persistent_execs")
          .set({ owner_json: JSON.stringify({ owner }) })
          .where("owner_key", "=", reservation.ownerKey),
      );
    });
  setOwner({ ...stale, namespace: "foreign-process-namespace" });
  expect((await recovery.claimRecovery(expected(prepared))).ok).toBe(false);
  const namespace: unknown[] = JSON.parse(prepared.owner.namespace!);
  const previousBoot = [
    namespace[0],
    "00000000-0000-4000-8000-000000000001",
    ...namespace.slice(2),
  ];
  if (cause === "previous boot") {
    setOwner({ ...stale, host: "foreign-host", namespace: JSON.stringify(previousBoot) });
    expect((await recovery.claimRecovery(expected(prepared))).ok).toBe(false);
    for (const rejected of [
      [namespace[0], namespace[1], "pid:[999999]", namespace[3]],
      [...previousBoot.slice(0, 3), "f".repeat(64)],
      [...previousBoot.slice(0, 3), null],
      previousBoot.slice(0, 3),
      [namespace[0], "invalid-boot", ...namespace.slice(2)],
    ]) {
      setOwner({ ...stale, namespace: JSON.stringify(rejected) });
      expect((await recovery.claimRecovery(expected(prepared))).ok).toBe(false);
    }
  }
  setOwner(
    cause === "previous boot"
      ? { ...prepared.owner, namespace: JSON.stringify(previousBoot) }
      : stale,
  );
  let claimed = accepted(await recovery.claimRecovery(expected(prepared)));
  expect(claimed.phase).toBe("stopping");
  expect(claimed.owner.token).not.toBe(prepared.owner.token);
  const uncertain = accepted(
    await recovery.transition({
      ...expected(claimed),
      phase: "uncertain",
      error: "transport unavailable",
    }),
  );
  claimed = accepted(await recovery.claimRecovery(expected(uncertain)));
  expect(claimed.phase).toBe("stopping");
  await expect(
    recovery.transition({ ...expected(claimed), phase: "running" }, assertCurrent),
  ).rejects.toThrow("Invalid persistent sandbox custody transition");
  expect((await store.transition({ ...expected(claimed), phase: "stopped" })).ok).toBe(false);
  vi.mocked(containerEngine.execContainer).mockResolvedValueOnce({
    code: 0,
    stdout: "replacement-daemon",
    stderr: "",
  });
  await expect(confirmStopped(recovery, claimed)).rejects.toThrow("Original Docker daemon changed");
  expect(await recovery.list()).toEqual([claimed]);
  const stopped = accepted(await confirmStopped(recovery, claimed));
  expect(await recovery.removeConfirmed(expected(stopped))).toEqual({ ok: true, current: null });
});
