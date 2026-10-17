import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { buildAcpDatabaseSessionKey, parseAcpDatabaseSessionKey } from "./session-meta-keys.js";
import { writeAcpSessionMetaForMigration } from "./session-meta.js";

/** Seed current metadata; migration fixtures write historical keys explicitly. */
export function seedCanonicalAcpSessionMeta(
  params: Parameters<typeof writeAcpSessionMetaForMigration>[0] & { agentId?: string },
): void {
  const identity = parseAcpDatabaseSessionKey(params.sessionKey);
  const sessionKey = normalizeStoreSessionKey(identity?.storeSessionKey ?? params.sessionKey);
  const agentId = params.agentId ?? identity?.agentId ?? parseAgentSessionKey(sessionKey)?.agentId;
  if (!agentId) {
    throw new Error("Canonical ACP fixture requires an explicit agent owner.");
  }
  writeAcpSessionMetaForMigration({
    ...params,
    sessionKey: buildAcpDatabaseSessionKey(sessionKey, agentId),
  });
}
