import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { RestartRecoveryOperatorSource } from "../gateway/operator-run-recovery.types.js";
import { isAcpSessionKey, isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { isAgentHarnessSessionKey } from "../sessions/agent-harness-session-key.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";

/** Admission writes this with its source claim, never by reconstructing session attribution. */
export function createRestartRecoveryOperatorSource(params: {
  authority?: AdmittedRunOperatorAuthority;
  entry: InternalSessionEntry;
  agentId: string;
  sessionKey: string;
  sourceRunId: string;
  inputProvenance?: InputProvenance;
}): RestartRecoveryOperatorSource | undefined {
  const { authority, entry, sessionKey } = params;
  if (!authority) {
    return undefined;
  }
  assertAdmittedRunOperatorAuthority(authority);
  authority.assertCurrent();
  const snapshot = authority.recoverySnapshot;
  // Dashboard roots link to main for grouping; only execution lineage excludes
  // recovery. Treating parentSessionKey as delegation strips real operator turns.
  if (
    !snapshot ||
    entry.incognito ||
    entry.spawnedBy ||
    entry.subagentRole ||
    (entry.spawnDepth ?? 0) > 0 ||
    entry.completionOwnerSessionKey ||
    entry.acp ||
    entry.pluginOwnerId ||
    entry.cronRunContinuation ||
    (params.inputProvenance && params.inputProvenance.kind !== "external_user") ||
    isCronSessionKey(sessionKey) ||
    isSubagentSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey) ||
    isAgentHarnessSessionKey(sessionKey)
  ) {
    return undefined;
  }
  const source: RestartRecoveryOperatorSource = {
    version: 1,
    agentId: params.agentId,
    sessionKey,
    sessionId: entry.sessionId,
    ...(entry.lifecycleRevision !== undefined
      ? { lifecycleRevision: entry.lifecycleRevision }
      : {}),
    sourceRunId: params.sourceRunId,
    snapshot: {
      ...structuredClone(snapshot),
      scopes: intersectOperatorScopes(snapshot.scopes, authority.scopes),
    },
  };
  return Buffer.byteLength(JSON.stringify(source), "utf8") <= 65_536
    ? freezeJsonSnapshot(source)
    : undefined;
}
