import type { DatabaseSync } from "node:sqlite";
import { prepareTranscriptRewriteSync } from "../../config/sessions/session-accessor.sqlite-branch-rewrite.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
} from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { replaceTranscriptSuffixEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-suffix-write.js";
import { replaceSessionWithBranchedTranscriptInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import type { SessionMaintenanceOperations } from "../../config/sessions/session-manager-write-contract.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";

type SessionMaintenanceContext = {
  database: DatabaseSync;
  admit(stage: "transaction" | "commit"): void;
};

export function executeSessionMaintenance(
  command: Extract<
    SqliteWorkerCommand<SessionMaintenanceOperations>,
    { type: "session.transcript.branch" }
  >,
  scope: SessionTranscriptWriteScope,
  context: SessionMaintenanceContext,
): SessionMaintenanceOperations["session.transcript.branch"]["output"];
export function executeSessionMaintenance(
  command: Extract<
    SqliteWorkerCommand<SessionMaintenanceOperations>,
    { type: "session.transcript.replaceSuffix" }
  >,
  scope: SessionTranscriptWriteScope,
  context: SessionMaintenanceContext,
): SessionMaintenanceOperations["session.transcript.replaceSuffix"]["output"];
export function executeSessionMaintenance(
  command: Extract<
    SqliteWorkerCommand<SessionMaintenanceOperations>,
    { type: "session.transcript.rewrite" }
  >,
  scope: SessionTranscriptWriteScope,
  context: SessionMaintenanceContext,
): SessionMaintenanceOperations["session.transcript.rewrite"]["output"];
export function executeSessionMaintenance(
  command: SqliteWorkerCommand<SessionMaintenanceOperations>,
  scope: SessionTranscriptWriteScope,
  context: SessionMaintenanceContext,
): SessionMaintenanceOperations[keyof SessionMaintenanceOperations]["output"] {
  // The host retains reconciliation beyond this worker command's lifetime.
  let projectionNeedsReconcile = false;
  const projection = {
    scheduleProjectionReconcile: false,
    onProjectionReconcileNeeded: () => {
      projectionNeedsReconcile = true;
    },
  };
  if (command.type === "session.transcript.branch") {
    return runOpenClawAgentWriteTransaction(
      (database) => {
        if (database.db !== context.database) {
          throw new Error("Session branch lost its borrowed canonical connection");
        }
        context.admit("transaction");
        const result = replaceSessionWithBranchedTranscriptInTransaction(
          database,
          scope,
          command.input.branch,
          command.input.expectedLifecycleRevision,
          undefined,
          projection,
        );
        context.admit("commit");
        return { ...result, projectionNeedsReconcile };
      },
      toDatabaseOptions(resolveSqliteTranscriptScope(scope)),
      { operationLabel: command.type },
    );
  }
  if (command.type === "session.transcript.replaceSuffix") {
    const [expected, next, prefix, mutationAt, startsAtPrefix, retained] = command.input.args;
    let version: SessionTranscriptContextVersion | undefined;
    const replaced = replaceTranscriptSuffixEventsSync(
      scope,
      expected,
      next,
      prefix,
      mutationAt,
      (committed) => {
        version = committed;
      },
      startsAtPrefix,
      retained,
      (stage) => context.admit(stage),
      projection,
    );
    return { replaced, version, projectionNeedsReconcile };
  }
  let version: SessionTranscriptContextVersion | undefined;
  const publish = prepareTranscriptRewriteSync(
    scope,
    command.input.appendParentId,
    () => {},
    command.input.version,
    (stage) => context.admit(stage),
    { messagesAlreadyRedacted: true, ...projection },
  );
  publish(command.input.entries, new Map(command.input.sources), (committed) => {
    version = committed;
  });
  if (!version) {
    throw new Error("Session rewrite did not return its committed version");
  }
  return { version, entries: command.input.entries, projectionNeedsReconcile };
}
