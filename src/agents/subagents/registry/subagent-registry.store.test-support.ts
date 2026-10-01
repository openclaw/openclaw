import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { bindSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "./subagent-registry.store.kernel.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function saveSubagentRegistryToSqlite(runs: Map<string, SubagentRunRecord>): void {
  const values = [...runs.values()].map(bindSubagentRunRecord);
  const retainedRunIds = values.map((row) => row.run_id);
  runOpenClawStateWriteTransaction((database) => {
    writeSubagentRunValuesInDatabase(database, values, []);
    const query = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "subagent_runs">>(
      database.db,
    ).deleteFrom("subagent_runs");
    executeSqliteQuerySync(
      database.db,
      retainedRunIds.length ? query.where("run_id", "not in", retainedRunIds) : query,
    );
  });
}
