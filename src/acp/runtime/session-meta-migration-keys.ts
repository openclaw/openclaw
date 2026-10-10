import type { DatabaseSync } from "node:sqlite";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { tryResolveLegacyDataOwnerAgentId } from "../../agents/agent-scope-config.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  acpSessionRowMatchesEntry,
  buildAcpDatabaseSessionKey,
  getAcpSessionKysely,
  parseAcpDatabaseSessionKey,
  selectAcpSessionRow,
} from "./session-meta-keys.js";
import type { AcpSessionEntryBinding, AcpSessionRow } from "./session-meta-read.types.js";

function parseLegacyAcpSessionKeyCandidates(
  sessionKey: string,
): Array<{ agentId?: string; storeSessionKey: string }> {
  const canonical = parseAcpDatabaseSessionKey(sessionKey);
  if (canonical) {
    return [
      {
        ...canonical,
        agentId:
          canonical.agentId ??
          parseAgentSessionKey(normalizeLowercaseStringOrEmpty(canonical.storeSessionKey))?.agentId,
      },
      { storeSessionKey: sessionKey },
    ];
  }
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  const parsed = parseAgentSessionKey(normalized);
  if (parsed?.rest.startsWith("acp:") && !parsed.rest.startsWith("acp:binding:")) {
    return [{ agentId: parsed.agentId, storeSessionKey: normalized }];
  }
  const prefix = "@agent:";
  if (sessionKey.startsWith(prefix)) {
    const remainder = sessionKey.slice(prefix.length);
    const separator = remainder.indexOf(":");
    if (separator > 0) {
      return [
        {
          agentId: normalizeAgentId(remainder.slice(0, separator)),
          storeSessionKey: remainder.slice(separator + 1),
        },
        { storeSessionKey: sessionKey },
      ];
    }
  }
  return [{ agentId: parsed?.agentId, storeSessionKey: sessionKey }];
}

type AcpSessionKeyCandidate = { agentId: string; storeSessionKey: string; ownerRecorded: boolean };

/** Doctor and startup admission share the complete set of historical owner interpretations. */
export function legacyAcpSessionKeyCandidates(
  sessionKey: string,
  agentIds: readonly string[],
): AcpSessionKeyCandidate[] {
  return parseLegacyAcpSessionKeyCandidates(sessionKey).flatMap<AcpSessionKeyCandidate>(
    (identity) =>
      identity.agentId
        ? [
            {
              agentId: identity.agentId,
              storeSessionKey: identity.storeSessionKey,
              ownerRecorded: true,
            },
          ]
        : agentIds.map((agentId) => ({
            agentId,
            storeSessionKey: identity.storeSessionKey,
            ownerRecorded: false,
          })),
  );
}

/** Legacy file imports inspect every supported prior key before deciding whether metadata is superseded. */
export function selectAcpMigrationRowForStoreEntry(
  database: DatabaseSync,
  sessionKey: string,
  agentId: string,
  cfg: OpenClawConfig,
  entry?: AcpSessionEntryBinding,
): AcpSessionRow | undefined {
  const normalizedKey = sessionKey.trim();
  const parsed = parseAgentSessionKey(normalizedKey);
  const persisted = resolvePersistedSessionStoreOwnerForKey(cfg, normalizedKey);
  const owner =
    persisted.kind === "configured"
      ? persisted.agentId
      : persisted.kind === "none"
        ? tryResolveLegacyDataOwnerAgentId(cfg)
        : undefined;
  const keys = [
    buildAcpDatabaseSessionKey(normalizedKey, agentId),
    ...(!parsed ? [`@agent:${normalizeAgentId(agentId)}:${normalizedKey}`] : []),
    ...(parsed || owner === normalizeAgentId(agentId) ? [normalizedKey] : []),
  ];
  for (const key of keys) {
    const row = selectAcpSessionRow(database, key);
    if (row && (!entry || acpSessionRowMatchesEntry(row, entry))) {
      return row;
    }
  }
  const normalized = normalizeLowercaseStringOrEmpty(normalizedKey);
  const free = parseAgentSessionKey(normalized);
  if (!free?.rest.startsWith("acp:") || free.rest.startsWith("acp:binding:")) {
    return undefined;
  }
  return executeSqliteQuerySync(
    database,
    getAcpSessionKysely(database)
      .selectFrom("acp_sessions")
      .selectAll()
      .where((eb) => eb.fn<string>("lower", ["session_key"]), "=", normalized)
      .orderBy("last_activity_at", "desc")
      .orderBy("session_key", "asc"),
  ).rows.find((row) => acpSessionRowMatchesEntry(row, entry));
}
