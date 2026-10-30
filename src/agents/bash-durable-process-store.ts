import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import type { RunExit } from "../process/supervisor/types.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { createOpenClawStateSchemaEnsurer } from "../state/openclaw-state-feature-schema-ensure.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import type { ProcessSession } from "./bash-process-registry.js";

/** Only registry-owned restart facts; never environment, output, or requester authority. */
export type DurableProcessRecord = Pick<
  ProcessSession,
  | "id"
  | "scopeKey"
  | "cwd"
  | "startedAt"
  | "cleanupMs"
  | "maxOutputChars"
  | "notifyOnExit"
  | "notifyOnExitEmptySuccess"
  | "cancellationRequested"
> & {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  unitName: string;
  command: string;
  logPath: string;
  result?: Pick<RunExit, "reason" | "exitCode" | "exitSignal" | "durationMs">;
  endedAt?: number;
  notificationSettled?: boolean;
};
type Mutation = { id: string; recordJson?: string };
const ensureSchema = createOpenClawStateSchemaEnsurer({
  table: "durable_background_processes",
  operationLabel: "durable-process.schema.ensure",
});

export const durableProcessOperations = {
  "durableProcess.write": function writeDurableProcess(
    input: Mutation,
    context: WorkerWriteOperationContext,
  ): void {
    ensureSchema({ ...context.stateOptions(), database: context.open() });
    context.writeAdmitted(
      ({ db }) => {
        const k = getNodeSqliteKysely<Pick<DB, "durable_background_processes">>(db);
        const row = { id: input.id, record_json: input.recordJson ?? "" };
        executeSqliteQuerySync(
          db,
          input.recordJson
            ? k
                .insertInto("durable_background_processes")
                .values(row)
                .onConflict((conflict) => conflict.column("id").doUpdateSet(row))
            : k.deleteFrom("durable_background_processes").where("id", "=", input.id),
        );
      },
      { operationLabel: "durable-process.write" },
    );
  },
};
export const durableProcessReadOperations = {
  "durableProcess.list": function listDurableProcesses(_input: undefined, db: EngineConnection) {
    return {
      type: "durableProcess.list" as const,
      records: !tableExists(db, "durable_background_processes")
        ? []
        : executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<Pick<DB, "durable_background_processes">>(db)
              .selectFrom("durable_background_processes")
              .select("record_json")
              .orderBy("id"),
            // SAFETY: The registry is the sole writer of this private, typed JSON record.
          ).rows.map((row) => JSON.parse(row.record_json) as DurableProcessRecord),
    };
  },
};

export function createDurableProcessStore(
  options: { env?: NodeJS.ProcessEnv; assertCurrent?: () => void } = {},
) {
  const context = captureOpenClawStateWorkerContext({ env: options.env });
  const assertOwned = () => {
    context.admission.assertCurrent();
    context.maintenanceScope?.assertAdmission();
    options.assertCurrent?.();
  };
  const write = async (input: Mutation, assertCurrent?: () => void) => {
    const guard = () => {
      assertOwned();
      assertCurrent?.();
    };
    guard();
    const { runOpenClawStateWorkerOperation } =
      await import("../state/openclaw-state-worker-store.js");
    await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "durableProcess.write", input }),
      {
        assertCurrent: guard,
        createAdmission: createSqliteWorkerWriteAdmission(guard, [context.admission.databasePath]),
      },
    );
  };
  return {
    assertCurrent: assertOwned,
    async list(): Promise<DurableProcessRecord[]> {
      assertOwned();
      const reply = await executeExistingOpenClawStateRead(
        { path: context.admission.databasePath, env: context.environment },
        { type: "durableProcess.list", input: undefined },
        { context, current: true },
      );
      assertOwned();
      return reply?.type === "durableProcess.list" ? reply.records : [];
    },
    upsert: (record: DurableProcessRecord, guard?: () => void) =>
      write({ id: record.id, recordJson: JSON.stringify(record) }, guard),
    remove: (id: string) => write({ id }),
  };
}
