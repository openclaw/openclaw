import { fileURLToPath } from "node:url";
import type { SnapshotDatabaseIdentity } from "../../src/snapshot/snapshot-provider.js";
import {
  assertSameCompactionPayload,
  assertSameReliabilityState,
  type CompactionPayloadProof,
  type ReliabilityStateProof,
} from "./sqlite-reliability-contract.js";
import { startReliabilityCrashWorker } from "./sqlite-reliability-process.js";
import {
  readReliabilitySidecarBytes,
  waitForReliabilitySidecars,
} from "./sqlite-reliability-sidecars.js";

type CompactionTarget = {
  identity: SnapshotDatabaseIdentity;
  path: string;
};

const COMPACTION_WORKER_PATH = fileURLToPath(
  new URL("./sqlite-reliability-compaction-worker.ts", import.meta.url),
);
const COMPACTION_TIMEOUT_MS = 120_000;
const MIN_ACTIVE_SIDECAR_BYTES = 1024 * 1024;

function workerArgs(target: CompactionTarget): string[] {
  if (target.identity.role === "global") {
    return ["global", target.path, ""];
  }
  if (target.identity.role === "agent") {
    return ["agent", target.path, target.identity.agentId];
  }
  throw new Error(`unsupported reliability target role: ${target.identity.role}`);
}

export async function runVacuumInterruptionProof(params: {
  env: NodeJS.ProcessEnv;
  expectedAutoVacuum: number;
  expectedPayload: CompactionPayloadProof;
  expectedState: ReliabilityStateProof;
  readAutoVacuum: () => number;
  readPayload: () => CompactionPayloadProof;
  recoverAndVerifyDatabase: () => ReliabilityStateProof;
  target: CompactionTarget;
}) {
  const worker = startReliabilityCrashWorker(COMPACTION_WORKER_PATH, workerArgs(params.target), {
    label: "SQLite compaction worker",
    env: params.env,
  });
  const { child, readStderr } = worker;

  try {
    await worker.waitForReady();
    const observed = await waitForReliabilitySidecars({
      child,
      databasePath: params.target.path,
      readStderr,
      ready: ({ journalBytes, walBytes }) =>
        journalBytes >= MIN_ACTIVE_SIDECAR_BYTES || walBytes >= MIN_ACTIVE_SIDECAR_BYTES,
      timeoutMs: COMPACTION_TIMEOUT_MS,
      exitMessage: "SQLite compaction completed before interruption evidence was observed.",
      timeoutMessage: `SQLite compaction did not produce ${MIN_ACTIVE_SIDECAR_BYTES} bytes of active journal evidence within 120 seconds.`,
    });
    const exit = await worker.crash();

    const stateAfterRecovery = params.recoverAndVerifyDatabase();
    assertSameReliabilityState(stateAfterRecovery, params.expectedState, "vacuum crash recovery");
    const autoVacuumAfterRecovery = params.readAutoVacuum();
    if (autoVacuumAfterRecovery !== params.expectedAutoVacuum) {
      throw new Error(
        `SQLite VACUUM committed before forced termination: expected auto_vacuum=${params.expectedAutoVacuum}, got ${autoVacuumAfterRecovery}`,
      );
    }
    const payloadAfterRecovery = params.readPayload();
    assertSameCompactionPayload(
      payloadAfterRecovery,
      params.expectedPayload,
      "vacuum crash recovery",
    );
    const { journalBytes: journalBytesAfterRecovery, walBytes: walBytesAfterRecovery } =
      readReliabilitySidecarBytes(params.target.path);
    if (journalBytesAfterRecovery !== 0 || walBytesAfterRecovery !== 0) {
      throw new Error(
        `SQLite recovery left active compaction sidecars: journal=${journalBytesAfterRecovery} wal=${walBytesAfterRecovery}`,
      );
    }

    return {
      autoVacuumAfterRecovery,
      autoVacuumBeforeKill: params.expectedAutoVacuum,
      exit,
      journalBytesObserved: observed.journalBytes,
      payloadAfterRecovery,
      payloadBeforeKill: params.expectedPayload,
      recoveryVerified: true,
      stateAfterRecovery,
      stateBeforeKill: params.expectedState,
      walBytesObserved: observed.walBytes,
    };
  } finally {
    await worker.stop();
  }
}
