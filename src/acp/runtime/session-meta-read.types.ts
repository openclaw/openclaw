import type { Selectable } from "kysely";
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";

export type AcpSessionsTable = OpenClawStateKyselyDatabase["acp_sessions"];
export type AcpSessionRow = Selectable<AcpSessionsTable>;
export type AcpSessionEntryBinding = Pick<SessionEntry, "lifecycleRevision"> &
  Partial<Pick<SessionEntry, "sessionId" | "sessionStartedAt">>;
export type AcpSessionReadInput = {
  keys: readonly string[];
  entry?: AcpSessionEntryBinding;
};

export type AcpResumeSessionRow = {
  sessionKey: string;
  session_id: string | null;
  updated_at: number;
};

export type AcpSessionReadCommand =
  | { type: "acpSessions.list" }
  | { type: "acpSessions.metadata"; entries: readonly AcpSessionReadInput[] }
  | {
      type: "acpSessions.resume";
      agentId: string;
      backendId?: string;
      resumeSessionId: string;
      sessionKey?: string;
    };

export type AcpSessionReadResult =
  | { type: "acpSessions.list"; rows: AcpSessionRow[] }
  | { type: "acpSessions.metadata"; rows: Array<AcpSessionRow | null> }
  | { type: "acpSessions.resume"; rows: AcpResumeSessionRow[] };

export type AcpSessionStoreEntry = {
  cfg: OpenClawConfig;
  agentId?: string;
  storePath: string;
  sessionKey: string;
  storeSessionKey: string;
  entry?: SessionEntry;
  acp?: SessionAcpMeta;
  storeReadFailed?: boolean;
};

export type AcpSessionReadContextInput = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  assertCurrent?: () => void;
};

export type AcpSessionEntryReadInput = AcpSessionReadContextInput & {
  sessionKey: string;
  agentId?: string;
  clone?: boolean;
};

export type PreparedAcpSessionEntryRead = {
  session: AcpSessionStoreEntry | null;
  assertCurrent(this: void): void;
  release(): void;
};

export type AcpSessionEntryPreparer = (
  params: AcpSessionEntryReadInput,
) => Promise<PreparedAcpSessionEntryRead> | undefined;
