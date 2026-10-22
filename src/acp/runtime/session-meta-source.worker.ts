import { readLegacyAcpMigrationContextInDatabase } from "../../config/sessions/session-accessor.sqlite-acp-provenance.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { withFreshOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-open.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  matchesAcpSessionRuntimeLocator,
  resolveAcpSessionControlOwner,
} from "./session-control-owner.js";
import type {
  AcpSessionControlConstraint,
  AcpSessionSourceReadInput,
} from "./session-meta-control.types.js";
import { assertAcpSessionMutationEntry } from "./session-meta-entry.kernel.js";
import { resolveReadableAcpSessionRow, selectAcpSessionRowForRead } from "./session-meta-keys.js";

/** Reuse the metadata writer's exact physical-source and lifecycle admission. */
export function readAcpSessionSourceInWorker(
  input: AcpSessionSourceReadInput,
  phase: "metadata preparation" | "legacy source consumption" | "control read",
) {
  const source = input.source;
  const assertSource = () => {
    const observed = readDatabasePathIdentitySync(source.path);
    if (
      observed.key !== source.identity.key ||
      observed.canonicalPath !== source.identity.canonicalPath ||
      observed.birthtime !== source.identity.birthtime
    ) {
      throw new Error(`Canonical ACP session changed before ${phase}.`);
    }
  };
  assertSource();
  const read = withFreshOpenClawAgentDatabaseReadOnly(
    (agent) =>
      readLegacyAcpMigrationContextInDatabase(
        agent,
        resolveSqliteSessionKey(input.sessionKey, input.agentId),
      ),
    { agentId: source.agentId, path: source.path, env: getSqliteWorkerStateContext().environment },
  );
  assertSource();
  if (!read.found && read.reason !== "database-missing") {
    throw new Error("Canonical ACP session is unavailable before source consumption");
  }
  const current = read.found ? read.value : { entry: undefined, sources: [] };
  assertAcpSessionMutationEntry(
    current.entry,
    input.entry ?? null,
    input.expectedControlBinding,
    phase,
  );
  return current;
}

/** Session mutations consume current rows; this constraint never grants authority. */
export function readAcpSessionControlInWorker(
  database: OpenClawStateDatabase,
  input: AcpSessionControlConstraint,
) {
  const shared = readDatabasePathIdentitySync(database.path);
  if (
    shared.key !== input.sharedSource.identity.key ||
    shared.canonicalPath !== input.sharedSource.identity.canonicalPath ||
    shared.birthtime !== input.sharedSource.identity.birthtime
  ) {
    throw new Error("Canonical ACP metadata source changed before control read.");
  }
  const { entry } = readAcpSessionSourceInWorker(input, "control read");
  if (resolveAcpSessionControlOwner(entry) !== input.ownerKey) {
    throw new Error("Canonical ACP session owner changed before control read.");
  }
  const row = resolveReadableAcpSessionRow({
    row: selectAcpSessionRowForRead(database.db, { ...input.read, entry }),
    entry,
  });
  if (
    input.runtimeLocator &&
    !matchesAcpSessionRuntimeLocator(
      row ? { backend: row.backend, runtimeSessionName: row.runtime_session_name } : undefined,
      input.runtimeLocator,
    )
  ) {
    throw new Error("Canonical ACP runtime locator changed before control read.");
  }
  return { entry, row };
}
