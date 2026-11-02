import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { RestartRecoveryOperatorSource } from "../gateway/operator-run-recovery-source.codec.js";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isIncognitoSessionKey,
} from "../routing/session-key.js";
import { isAgentHarnessSessionKey } from "../sessions/agent-harness-session-key.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";

type ScheduledOperatorSourceParams = {
  authority?: AdmittedRunOperatorAuthority;
  entry: InternalSessionEntry;
  agentId: string;
  sessionKey: string;
  sourceRunId: string;
};

/** Cron occurrences retain the creator turn's authenticated grant for later revalidation. */
export function captureScheduledOperatorSource(
  params: ScheduledOperatorSourceParams,
): RestartRecoveryOperatorSource | undefined {
  const { authority, entry, sessionKey } = params;
  if (
    !authority ||
    entry.incognito ||
    entry.acp ||
    entry.pluginOwnerId ||
    entry.cronRunContinuation ||
    isIncognitoSessionKey(sessionKey) ||
    isCronSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey) ||
    isAgentHarnessSessionKey(sessionKey)
  ) {
    return undefined;
  }
  assertAdmittedRunOperatorAuthority(authority);
  authority.assertCurrent();
  const snapshot = authority.recoverySnapshot;
  if (!snapshot) {
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
      ...snapshot,
      scopes: intersectOperatorScopes(snapshot.scopes, authority.scopes),
    },
  };
  return Buffer.byteLength(JSON.stringify(source), "utf8") <= 65_536
    ? freezeJsonSnapshot(source)
    : undefined;
}
