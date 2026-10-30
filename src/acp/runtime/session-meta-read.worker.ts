import { expectDefined } from "@openclaw/normalization-core/expect";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { isInternalSessionEffectsKey } from "../../config/sessions/internal-session-key.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope-helpers.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { isIncognitoSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import {
  CONTENT_VERSION_KEY,
  readStateSchemaContentVersionRow,
} from "../../state/openclaw-state-db-schema-version.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  acpSessionRowMatchesEntry,
  selectAcpSessionRows,
  selectAcpSessionRowsByKeys,
  buildAcpDatabaseSessionKey,
  getAcpSessionKysely,
  parseAcpDatabaseSessionKey,
} from "./session-meta-keys.js";
import type {
  AcpResumeSessionRow,
  AcpSessionReadCommand,
  AcpSessionReadResult,
  AcpSessionRow,
} from "./session-meta-read.types.js";

/** Admission validates the marker before publishing metadata from the same statement. */
export function prepareAcpSessionMetadataRead(
  command: Extract<AcpSessionReadCommand, { type: "acpSessions.metadata" }>,
) {
  const keys = [...new Set(command.entries.flatMap((entry) => entry.keys))];
  let firstCohort: AcpSessionRow[] | undefined;
  let failed: { error: unknown } | undefined;
  return {
    readContentVersionRow(this: void, db: EngineConnection) {
      try {
        const database = getNodeSqliteKysely<Pick<DB, "acp_sessions" | "config_machine_state">>(db);
        const rows = executeSqliteQuerySync(
          db,
          database
            .selectFrom(database.selectNoFrom((eb) => eb.val(1).as("anchor")).as("admission"))
            .leftJoin("config_machine_state as marker", (join) =>
              join.on("marker.state_key", "=", CONTENT_VERSION_KEY),
            )
            .leftJoin("acp_sessions", (join) =>
              join.on("acp_sessions.session_key", "in", sqliteStringSet(keys.slice(0, 500))),
            )
            .selectAll("acp_sessions")
            .select([
              "marker.state_key as content_version_key",
              "marker.value_json as content_version",
            ]),
        ).rows;
        firstCohort = rows.flatMap(
          ({ content_version_key: _markerKey, content_version: _markerValue, ...row }) => {
            if (row.session_key === null) {
              return [];
            }
            // A missing LEFT JOIN row makes all ACP fields nullable together.
            return [
              {
                ...row,
                session_key: row.session_key,
                backend: expectDefined(row.backend, "ACP backend"),
                agent: expectDefined(row.agent, "ACP agent"),
                runtime_session_name: expectDefined(
                  row.runtime_session_name,
                  "ACP runtime session",
                ),
                mode: expectDefined(row.mode, "ACP mode"),
                state: expectDefined(row.state, "ACP state"),
                last_activity_at: expectDefined(row.last_activity_at, "ACP activity time"),
                updated_at: expectDefined(row.updated_at, "ACP metadata time"),
              },
            ];
          },
        );
        const marker = rows[0];
        return marker?.content_version_key === CONTENT_VERSION_KEY
          ? { value_json: marker.content_version }
          : undefined;
      } catch (error) {
        // A newer or malformed marker must keep its actionable refusal even if
        // that version's ACP payload cannot be read by this build.
        failed = { error };
        return readStateSchemaContentVersionRow(db);
      }
    },
    read(db: EngineConnection) {
      if (failed) {
        throw failed.error;
      }
      return readAcpSessionMetadata(db, command, keys, firstCohort);
    },
  };
}

function selectAcpResumeSessions(
  db: EngineConnection,
  input: Extract<AcpSessionReadCommand, { type: "acpSessions.resume" }>,
): AcpResumeSessionRow[] {
  const rows = executeSqliteQuerySync(
    db,
    getAcpSessionKysely(db)
      .selectFrom("acp_sessions")
      .select(["session_key", "session_id", "updated_at", "backend", "agent"])
      .$if(input.sessionKey !== undefined, (query) =>
        query.where(
          "session_key",
          "=",
          buildAcpDatabaseSessionKey(input.sessionKey!, input.agentId),
        ),
      )
      .where((eb) =>
        eb.or([
          eb("resume_agent_session_id", "=", input.resumeSessionId),
          eb("resume_acpx_session_id", "=", input.resumeSessionId),
        ]),
      ),
  ).rows;
  const agentId = normalizeAgentId(input.agentId);
  const backendId = normalizeOptionalLowercaseString(input.backendId);
  return rows
    .flatMap((row) => {
      const key = parseAcpDatabaseSessionKey(row.session_key);
      // Point readers accept aliases; orphan metadata must not reattach through that coercion.
      return key?.agentId === agentId &&
        key.storeSessionKey === resolveSqliteSessionKey(key.storeSessionKey, agentId) &&
        !isInternalSessionEffectsKey(key.storeSessionKey) &&
        !isIncognitoSessionKey(key.storeSessionKey) &&
        (!backendId || normalizeOptionalLowercaseString(row.backend) === backendId)
        ? [
            {
              sessionKey: key.storeSessionKey,
              session_id: row.session_id,
              updated_at: row.updated_at,
              agent: row.agent,
            },
          ]
        : [];
    })
    .toSorted((a, b) => Buffer.compare(Buffer.from(a.sessionKey), Buffer.from(b.sessionKey)));
}

export function readAcpSessionCommand(
  db: EngineConnection,
  command: AcpSessionReadCommand,
): AcpSessionReadResult {
  if (command.type === "acpSessions.list") {
    return { type: command.type, rows: selectAcpSessionRows(db) };
  }
  if (command.type === "acpSessions.resume") {
    return { type: command.type, rows: selectAcpResumeSessions(db, command) };
  }
  const cohortKeys = [...new Set(command.entries.flatMap((entry) => entry.keys))];
  return readAcpSessionMetadata(db, command, cohortKeys);
}

function readAcpSessionMetadata(
  db: EngineConnection,
  command: Extract<AcpSessionReadCommand, { type: "acpSessions.metadata" }>,
  cohortKeys: readonly string[],
  firstCohort?: readonly AcpSessionRow[],
): Extract<AcpSessionReadResult, { type: "acpSessions.metadata" }> {
  const rows = new Map<string, AcpSessionRow>();
  for (const row of selectAcpSessionRowsByKeys(db, cohortKeys, firstCohort)) {
    rows.set(row.session_key, row);
  }
  return {
    type: command.type,
    rows: command.entries.map(({ keys, entry }) => {
      for (const key of keys) {
        const row = rows.get(key);
        if (row && acpSessionRowMatchesEntry(row, entry)) {
          return row;
        }
      }
      return null;
    }),
  };
}
