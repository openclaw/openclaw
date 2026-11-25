import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalSqliteSnapshotProvider } from "../../src/snapshot/local-repository.js";
import {
  SNAPSHOT_SQLITE_FILENAME,
  type SnapshotDatabaseIdentity,
  type SnapshotSummary,
} from "../../src/snapshot/snapshot-provider.js";
import {
  assertSameCompactionPayload,
  assertSameReliabilityState,
  type CompactionPayloadProof,
  type ReliabilityStateProof,
} from "./sqlite-reliability-contract.js";
import { startReliabilityCrashWorker } from "./sqlite-reliability-process.js";

type RepositoryCrashPoint = "after-commit" | "before-pending" | "pending";
const REPOSITORY_WORKER_PATH = fileURLToPath(
  new URL("./sqlite-reliability-repository-worker.ts", import.meta.url),
);

async function verifySnapshot(params: {
  expectedPayload: CompactionPayloadProof;
  expectedState: ReliabilityStateProof;
  provider: ReturnType<typeof createLocalSqliteSnapshotProvider>;
  snapshot: SnapshotSummary;
  verifyPayload: (databasePath: string) => CompactionPayloadProof;
  verifyState: (databasePath: string) => ReliabilityStateProof;
}): Promise<void> {
  await params.provider.verify(params.snapshot.ref);
  const artifactPath = path.join(params.snapshot.ref.path, SNAPSHOT_SQLITE_FILENAME);
  assertSameReliabilityState(params.verifyState(artifactPath), params.expectedState, artifactPath);
  assertSameCompactionPayload(
    params.verifyPayload(artifactPath),
    params.expectedPayload,
    artifactPath,
  );
}

function listRepositoryEntries(repositoryPath: string): string[] {
  return fs.existsSync(repositoryPath) ? fs.readdirSync(repositoryPath) : [];
}

async function runCrashPoint(
  params: Parameters<typeof runRepositoryInterruptionProof>[0] & {
    crashPoint: RepositoryCrashPoint;
    provider: ReturnType<typeof createLocalSqliteSnapshotProvider>;
  },
) {
  const visibleBefore = await params.provider.list();
  const visiblePathsBefore = new Set(
    visibleBefore.map((snapshot) => path.resolve(snapshot.ref.path)),
  );
  const entriesBefore = new Set(listRepositoryEntries(params.repositoryPath));
  const worker = startReliabilityCrashWorker(
    REPOSITORY_WORKER_PATH,
    [
      params.crashPoint,
      params.repositoryPath,
      params.validationRootPath,
      params.sourcePath,
      JSON.stringify(params.identity),
    ],
    {
      label: "SQLite repository worker",
      cwd: process.cwd(),
    },
  );

  try {
    await worker.waitForCrashPoint(params.crashPoint);
    const exit = await worker.crash(params.crashPoint);

    const createdEntries = listRepositoryEntries(params.repositoryPath).filter(
      (entry) => !entriesBefore.has(entry),
    );
    const visibleAfter = await params.provider.list();
    const crashSnapshots = visibleAfter.filter(
      (snapshot) => !visiblePathsBefore.has(path.resolve(snapshot.ref.path)),
    );
    const expectedVisibleCrashSnapshots = params.crashPoint === "before-pending" ? 0 : 1;
    if (crashSnapshots.length !== expectedVisibleCrashSnapshots) {
      throw new Error(
        `SQLite repository exposed ${crashSnapshots.length} snapshot(s) at ${params.crashPoint}; expected ${expectedVisibleCrashSnapshots}.`,
      );
    }
    for (const snapshot of visibleAfter) {
      await verifySnapshot({ ...params, snapshot });
    }

    const sourceState = params.verifyState(params.sourcePath);
    assertSameReliabilityState(sourceState, params.expectedState, `${params.crashPoint} source`);
    const sourcePayload = params.verifyPayload(params.sourcePath);
    assertSameCompactionPayload(
      sourcePayload,
      params.expectedPayload,
      `${params.crashPoint} source`,
    );

    const crashSnapshotNames = new Set(
      crashSnapshots.map((snapshot) => path.basename(snapshot.ref.path)),
    );
    const residueEntries = createdEntries.filter((entry) => !crashSnapshotNames.has(entry));
    const stagingEntries = residueEntries.filter((entry) => entry.startsWith(".tmp-")).length;
    const incompleteEntries = residueEntries.length - stagingEntries;
    if (stagingEntries === 0) {
      throw new Error(`SQLite repository worker left no staging at ${params.crashPoint}.`);
    }
    const expectedIncompleteEntries = params.crashPoint === "before-pending" ? 1 : 0;
    if (incompleteEntries !== expectedIncompleteEntries) {
      throw new Error(
        `SQLite repository left ${incompleteEntries} incomplete final entries at ${params.crashPoint}; expected ${expectedIncompleteEntries}.`,
      );
    }

    const retry = await params.provider.create({
      identity: params.identity,
      path: params.sourcePath,
    });
    const retrySnapshot = (await params.provider.list()).find(
      (snapshot) => path.resolve(snapshot.ref.path) === path.resolve(retry.ref.path),
    );
    if (!retrySnapshot) {
      throw new Error(`SQLite repository retry was not visible after ${params.crashPoint}.`);
    }
    await verifySnapshot({ ...params, snapshot: retrySnapshot });
    for (const entry of createdEntries) {
      if (!fs.existsSync(path.join(params.repositoryPath, entry))) {
        throw new Error(`SQLite repository retry removed crash residue it did not own: ${entry}`);
      }
    }

    return {
      crashSnapshotVerifiedAfterCrash: crashSnapshots.length === 1,
      crashSnapshotVisibleAfterCrash: crashSnapshots.length === 1,
      exit,
      incompleteEntries,
      payload: sourcePayload,
      stagingEntries,
      state: sourceState,
      visibleSnapshotsAfterCrash: visibleAfter.length,
      repositoryVerified: true,
      retryCreated: true,
      sourcePayloadPreserved: true,
      sourceStatePreserved: true,
    };
  } finally {
    await worker.stop();
  }
}

export async function runRepositoryInterruptionProof(params: {
  expectedPayload: CompactionPayloadProof;
  expectedState: ReliabilityStateProof;
  identity: SnapshotDatabaseIdentity;
  repositoryPath: string;
  sourcePath: string;
  validationRootPath: string;
  verifyPayload: (databasePath: string) => CompactionPayloadProof;
  verifyState: (databasePath: string) => ReliabilityStateProof;
}) {
  const provider = createLocalSqliteSnapshotProvider({
    repositoryPath: params.repositoryPath,
    validationRootPath: params.validationRootPath,
  });
  const baseline = await provider.create({
    identity: params.identity,
    path: params.sourcePath,
  });
  const baselineSnapshot = (await provider.list()).find(
    (snapshot) => path.resolve(snapshot.ref.path) === path.resolve(baseline.ref.path),
  );
  if (!baselineSnapshot) {
    throw new Error("SQLite repository baseline snapshot was not visible.");
  }
  await verifySnapshot({ ...params, provider, snapshot: baselineSnapshot });

  const beforePending = await runCrashPoint({
    ...params,
    crashPoint: "before-pending",
    provider,
  });
  const pending = await runCrashPoint({
    ...params,
    crashPoint: "pending",
    provider,
  });
  const afterCommit = await runCrashPoint({
    ...params,
    crashPoint: "after-commit",
    provider,
  });

  return { afterCommit, beforePending, pending };
}
