import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { getAdmittedSqlSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import {
  parseStateLeaseProcessOwner,
  readNamespacedStateLeaseProcessOwnerStatus,
  type NamespacedStateLeaseProcessOwner,
} from "../../infra/state-lease-process-owner.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type {
  SandboxPersistentExecMutationResult,
  SandboxPersistentExecPhase,
  SandboxPersistentExecQuery,
  SandboxPersistentExecRecord,
  SandboxPersistentExecReservation,
  SandboxPersistentExecWorkspaceBinding,
  SandboxPersistentExecWrite,
} from "./persistent-exec-store.types.js";
import {
  dockerPersistentExecContainerName,
  parseDockerPersistentExecReceipt,
  parseDockerPersistentExecTarget,
} from "./persistent-exec.types.js";
import {
  assertSandboxRegistryWorkspaceBinding,
  readSandboxRegistryEntryInDatabase,
} from "./registry.kernel.js";

type CustodyDatabase = Pick<DB, "sandbox_persistent_execs">;
type CustodyRow = Selectable<DB["sandbox_persistent_execs"]>;
const phases: readonly SandboxPersistentExecPhase[] = [
  "reserved",
  "prepared",
  "running",
  "stopping",
  "uncertain",
  "stopped",
];
const transitions: Record<SandboxPersistentExecPhase, readonly SandboxPersistentExecPhase[]> = {
  reserved: ["prepared", "stopping", "uncertain"],
  prepared: ["running", "stopping", "uncertain"],
  running: ["stopping", "uncertain"],
  stopping: ["uncertain"],
  uncertain: ["stopping", "uncertain"],
  stopped: [],
};

function boundedText(value: unknown, limit = 4096): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= limit && !value.includes("\0")
  );
}

function invalidCustody(): never {
  throw new Error("Invalid persistent sandbox custody; retain the record for recovery.");
}

function parseWorkspaceBinding(value: unknown): SandboxPersistentExecWorkspaceBinding {
  if (
    !isRecord(value) ||
    !boundedText(value.workspaceDir) ||
    (value.workspaceSource !== null && value.workspaceSource !== "managed-worktree") ||
    typeof value.registryCreatedAtMs !== "number" ||
    !Number.isSafeInteger(value.registryCreatedAtMs) ||
    value.registryCreatedAtMs < 0
  ) {
    invalidCustody();
  }
  return {
    workspaceDir: value.workspaceDir,
    workspaceSource: value.workspaceSource,
    registryCreatedAtMs: value.registryCreatedAtMs,
  };
}

function validateReservation(input: SandboxPersistentExecReservation): void {
  if (
    !boundedText(input.ownerKey) ||
    !boundedText(input.sourceIdentity) ||
    !boundedText(input.attemptId, 128) ||
    input.backendId !== "docker" ||
    !/^[a-f0-9]{64}$/u.test(input.containerId) ||
    !boundedText(input.containerName, 256) ||
    !boundedText(input.containerStartedAt, 128) ||
    !Number.isFinite(Date.parse(input.containerStartedAt))
  ) {
    invalidCustody();
  }
  dockerPersistentExecContainerName(input.attemptId);
  parseDockerPersistentExecTarget(input.backendTarget);
}

function decode(row: CustodyRow): SandboxPersistentExecRecord {
  const ownerPayload: unknown = JSON.parse(row.owner_json);
  const processOwner = parseStateLeaseProcessOwner(row.owner_json);
  const owner = isRecord(ownerPayload) && isRecord(ownerPayload.owner) ? ownerPayload.owner : null;
  const phase = phases.find((candidate) => candidate === row.phase);
  if (
    !owner ||
    !processOwner ||
    !boundedText(owner.token, 128) ||
    (owner.namespace !== null && !boundedText(owner.namespace)) ||
    !phase ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !Number.isSafeInteger(row.created_at_ms) ||
    row.created_at_ms < 0 ||
    !Number.isSafeInteger(row.updated_at_ms) ||
    row.updated_at_ms < 0 ||
    (row.error !== null && (typeof row.error !== "string" || row.error.length > 2048)) ||
    row.backend_id !== "docker"
  ) {
    invalidCustody();
  }
  const record: SandboxPersistentExecRecord = {
    ownerKey: row.owner_key,
    sourceIdentity: row.source_identity,
    attemptId: row.attempt_id,
    backendId: row.backend_id,
    backendTarget: parseDockerPersistentExecTarget(JSON.parse(row.backend_target_json)),
    workspaceBinding: parseWorkspaceBinding(JSON.parse(row.workspace_binding_json)),
    containerId: row.container_id,
    containerName: row.container_name,
    containerStartedAt: row.container_started_at,
    owner: { ...processOwner, token: owner.token, namespace: owner.namespace },
    revision: row.revision,
    phase,
    receipt:
      row.receipt_json === null
        ? null
        : parseDockerPersistentExecReceipt(JSON.parse(row.receipt_json)),
    error: row.error,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
  validateReservation(record);
  assertReceiptBinding(record, record.receipt);
  if ((phase === "prepared" || phase === "running") && !record.receipt) {
    invalidCustody();
  }
  return record;
}

function assertReceiptBinding(
  record: SandboxPersistentExecReservation,
  receipt: SandboxPersistentExecRecord["receipt"],
): void {
  if (
    receipt &&
    (receipt.parentContainerId !== record.containerId ||
      receipt.attemptId !== record.attemptId ||
      !isDeepStrictEqual(receipt.target, record.backendTarget))
  ) {
    throw new Error("Persistent sandbox stop receipt changed its reserved target.");
  }
}

/** Absence is an admitted schema fact; runtime reads never create or probe a table. */
export function readSandboxPersistentExecsInDatabase(
  db: EngineConnection,
  input: SandboxPersistentExecQuery,
): SandboxPersistentExecRecord[] {
  if (!getAdmittedSqlSchemaFacts(db)) {
    throw new Error("Persistent sandbox custody requires admitted schema facts.");
  }
  if (!tableExists(db, "sandbox_persistent_execs")) {
    return [];
  }
  let query = getNodeSqliteKysely<CustodyDatabase>(db)
    .selectFrom("sandbox_persistent_execs")
    .selectAll();
  if (input.ownerKey !== undefined) {
    query = query.where("owner_key", "=", input.ownerKey);
  }
  if (input.sourceIdentity !== undefined) {
    query = query.where("source_identity", "=", input.sourceIdentity);
  }
  if (input.containerId !== undefined) {
    query = query.where("container_id", "=", input.containerId);
  }
  if (input.containerName !== undefined) {
    query = query.where("container_name", "=", input.containerName);
  }
  return executeSqliteQuerySync(db, query.orderBy("owner_key")).rows.map(decode);
}

/** The registry worker calls this only inside its admitted synchronous transaction. */
export function writeSandboxPersistentExecInDatabase(
  db: EngineConnection,
  write: SandboxPersistentExecWrite,
  processOwner: NamespacedStateLeaseProcessOwner,
  reservationWorkspace?: SandboxPersistentExecWorkspaceBinding,
): SandboxPersistentExecMutationResult {
  const { input } = write;
  const current = readSandboxPersistentExecsInDatabase(db, { ownerKey: input.ownerKey })[0] ?? null;
  const k = getNodeSqliteKysely<CustodyDatabase>(db);
  if (write.operation === "reserve") {
    if (current) {
      return { ok: false, current };
    }
    validateReservation(write.input);
    const workspaceBinding = parseWorkspaceBinding(reservationWorkspace);
    if (
      write.expectedSource &&
      write.expectedSource.sourceIdentity !== write.input.sourceIdentity
    ) {
      throw new Error("Persistent sandbox reservation differs from its current cron source.");
    }
    const now = Date.now();
    executeSqliteQuerySync(
      db,
      k.insertInto("sandbox_persistent_execs").values({
        owner_key: write.input.ownerKey,
        source_identity: write.input.sourceIdentity,
        attempt_id: write.input.attemptId,
        owner_json: JSON.stringify({ owner: { ...processOwner, token: write.ownerToken } }),
        backend_id: write.input.backendId,
        backend_target_json: JSON.stringify(
          parseDockerPersistentExecTarget(write.input.backendTarget),
        ),
        workspace_binding_json: JSON.stringify(workspaceBinding),
        container_id: write.input.containerId,
        container_name: write.input.containerName,
        container_started_at: write.input.containerStartedAt,
        revision: 1,
        phase: "reserved",
        receipt_json: null,
        error: null,
        created_at_ms: now,
        updated_at_ms: now,
      }),
    );
  } else {
    if (
      !current ||
      current.attemptId !== write.input.attemptId ||
      current.revision !== write.input.expectedRevision
    ) {
      return { ok: false, current };
    }
    if (write.operation === "claimRecovery") {
      const retainedCleanup =
        current.owner.token === write.ownerToken &&
        (current.phase === "stopping" ||
          current.phase === "uncertain" ||
          current.phase === "stopped");
      if (
        !retainedCleanup &&
        readNamespacedStateLeaseProcessOwnerStatus(current.owner, processOwner.namespace) !== "dead"
      ) {
        return { ok: false, current };
      }
    } else if (
      write.operation !== "confirmContainerExtinction" &&
      current.owner.token !== write.ownerToken
    ) {
      return { ok: false, current };
    }
    if (
      "expectedSource" in write &&
      write.expectedSource &&
      write.expectedSource.sourceIdentity !== current.sourceIdentity
    ) {
      throw new Error("Persistent sandbox custody differs from its current cron source.");
    }
    if (write.operation === "checkExecutionCurrent") {
      return { ok: current.phase === "prepared" || current.phase === "running", current };
    }
    if (write.operation === "removeConfirmed") {
      if (current.phase !== "stopped") {
        throw new Error("Persistent sandbox cleanup has not been confirmed.");
      }
      if (write.requireWorkspaceBinding) {
        assertSandboxRegistryWorkspaceBinding(
          readSandboxRegistryEntryInDatabase(db, current.containerName),
          current.workspaceBinding,
        );
      }
      executeSqliteQuerySync(
        db,
        k
          .deleteFrom("sandbox_persistent_execs")
          .where("owner_key", "=", current.ownerKey)
          .where("attempt_id", "=", current.attemptId)
          .where("revision", "=", current.revision),
      );
      return { ok: true, current: null };
    }
    if (current.revision === Number.MAX_SAFE_INTEGER) {
      throw new Error("Persistent sandbox custody revision exhausted.");
    }
    let next: SandboxPersistentExecRecord;
    if (write.operation === "confirmContainerExtinction") {
      if (
        write.extinction.parentContainerId !== current.containerId ||
        write.extinction.attemptId !== current.attemptId ||
        (current.receipt !== null &&
          write.extinction.containerId !== current.receipt.containerId) ||
        !isDeepStrictEqual(write.extinction.target, current.backendTarget)
      ) {
        throw new Error(
          "Persistent sandbox extinction proof differs from the retained container generation.",
        );
      }
      next = { ...current, owner: { ...processOwner, token: write.ownerToken }, phase: "stopped" };
    } else if (write.operation === "claimRecovery") {
      next = {
        ...current,
        owner: { ...processOwner, token: write.ownerToken },
        phase: current.phase === "stopped" ? "stopped" : "stopping",
      };
    } else {
      if (!transitions[current.phase].includes(write.input.phase)) {
        throw new Error("Invalid persistent sandbox custody transition.");
      }
      const receipt =
        write.input.receipt === undefined
          ? current.receipt
          : parseDockerPersistentExecReceipt(write.input.receipt);
      assertReceiptBinding(current, receipt);
      if (current.receipt && !isDeepStrictEqual(current.receipt, receipt)) {
        throw new Error("Persistent sandbox stream container identity changed.");
      }
      if ((write.input.phase === "prepared" || write.input.phase === "running") && !receipt) {
        throw new Error("Persistent sandbox launch requires a recorded private container.");
      }
      const error = write.input.error === undefined ? current.error : write.input.error;
      if (error !== null && (typeof error !== "string" || error.length > 2048)) {
        invalidCustody();
      }
      next = { ...current, phase: write.input.phase, receipt, error };
    }
    executeSqliteQuerySync(
      db,
      k
        .updateTable("sandbox_persistent_execs")
        .set({
          owner_json: JSON.stringify({ owner: next.owner }),
          phase: next.phase,
          receipt_json: next.receipt ? JSON.stringify(next.receipt) : null,
          error: next.error,
          revision: current.revision + 1,
          updated_at_ms: Date.now(),
        })
        .where("owner_key", "=", current.ownerKey)
        .where("attempt_id", "=", current.attemptId)
        .where("revision", "=", current.revision),
    );
  }
  return {
    ok: true,
    current: readSandboxPersistentExecsInDatabase(db, { ownerKey: input.ownerKey })[0] ?? null,
  };
}

export const sandboxPersistentExecReadOperations = {
  "sandboxPersistentExec.list": (input: SandboxPersistentExecQuery, db: EngineConnection) => ({
    type: "sandboxPersistentExec.list" as const,
    records: readSandboxPersistentExecsInDatabase(db, input),
  }),
};
