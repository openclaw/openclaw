import type { Selectable } from "kysely";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";

export type AcpSessionsTable = OpenClawStateKyselyDatabase["acp_sessions"];
export type AcpSessionRow = Selectable<AcpSessionsTable>;
export type AcpSessionEntryBinding = Pick<SessionEntry, "lifecycleRevision"> &
  Partial<Pick<SessionEntry, "sessionId" | "sessionStartedAt">>;
export type AcpSessionReadInput = {
  keys: readonly string[];
  entry?: AcpSessionEntryBinding;
};
