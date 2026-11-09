import type { Selectable } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";

export type SubagentRunSqliteRow = Selectable<OpenClawStateKyselyDatabase["subagent_runs"]>;
