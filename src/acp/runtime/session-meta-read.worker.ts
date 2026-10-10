import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { sql } from "kysely";
import { isInternalSessionEffectsKey } from "../../config/sessions/internal-session-key.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope-helpers.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
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
  const keys = [...new Set(command.entries.flatMap((entry) => entry.keys))].slice(0, 500);
  let firstCohort: AcpSessionRow[] | undefined;
  let failed: { error: unknown } | undefined;
  return {
    readContentVersionRow(this: void, db: DatabaseSync) {
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
              join.on("acp_sessions.session_key", "in", sqliteStringSet(keys)),
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
    read(db: DatabaseSync) {
      if (failed) {
        throw failed.error;
      }
      return readAcpSessionCommand(db, command, firstCohort);
    },
  };
}

function selectAcpResumeSessions(
  db: DatabaseSync,
  input: Extract<AcpSessionReadCommand, { type: "acpSessions.resume" }>,
): AcpResumeSessionRow[] {
  // Match String.trim(), including historical whitespace, without decoding metadata on the host.
  // These expressions must match the canonical resume indexes.
  const whitespace = sql`char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)`;
  const identity = sql`CASE WHEN json_valid(identity_json) THEN identity_json END`;
  const agentSessionId = sql`trim(json_extract(${identity}, '$.agentSessionId'), ${whitespace})`;
  const acpxSessionId = sql`trim(json_extract(${identity}, '$.acpxSessionId'), ${whitespace})`;
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
          eb.and([
            eb(agentSessionId, "=", input.resumeSessionId),
            eb(sql`json_type(${identity}, '$.agentSessionId')`, "=", "text"),
          ]),
          eb.and([
            eb(acpxSessionId, "=", input.resumeSessionId),
            eb(sql`json_type(${identity}, '$.acpxSessionId')`, "=", "text"),
          ]),
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
  db: DatabaseSync,
  command: AcpSessionReadCommand,
  firstCohort?: readonly AcpSessionRow[],
): AcpSessionReadResult {
  if (command.type === "acpSessions.list") {
    return { type: command.type, rows: selectAcpSessionRows(db) };
  }
  if (command.type === "acpSessions.resume") {
    return { type: command.type, rows: selectAcpResumeSessions(db, command) };
  }
  const cohortKeys = [...new Set(command.entries.flatMap((entry) => entry.keys))];
  const rows = new Map(
    [...selectAcpSessionRowsByKeys(db, cohortKeys, firstCohort)].map((row) => [
      row.session_key,
      row,
    ]),
  );
  return {
    type: command.type,
    rows: command.entries.map(
      ({ keys, entry }) =>
        keys
          .map((key) => rows.get(key))
          .find((row) => row && (!entry || acpSessionRowMatchesEntry(row, entry))) ?? null,
    ),
  };
}
