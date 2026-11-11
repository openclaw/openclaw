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
  entry?: InternalSessionEntry;
  agentId: string;
  sessionKey?: string;
  sourceRunId: string;
  /** A direct human reauthorizing an already source-bound job supplies a real Gateway snapshot. */
  independent?: boolean;
};

/** Retains authenticated permission independently of where the automation will execute. */
export function captureScheduledOperatorSource(
  params: ScheduledOperatorSourceParams,
): RestartRecoveryOperatorSource | undefined {
  const { authority, entry, sessionKey } = params;
  if (!authority) {
    return undefined;
  }
  assertAdmittedRunOperatorAuthority(authority);
  authority.assertCurrent();
  const independent = Boolean(authority.openclawIdPrincipal || params.independent);
  const unavailable = () => {
    if (independent) {
      throw new Error(
        "The original authenticated authority could not be retained for this automation.",
      );
    }
    return undefined;
  };
  const snapshot = authority.recoverySnapshot;
  if (!snapshot) {
    return unavailable();
  }
  let source: RestartRecoveryOperatorSource;
  if (independent) {
    // No conversation IDs or contents are needed to retain the authenticated device grant.
    source = {
      version: 1,
      kind: "gateway",
      agentId: params.agentId,
      sourceRunId: params.sourceRunId,
      snapshot: { ...snapshot, scopes: intersectOperatorScopes(snapshot.scopes, authority.scopes) },
    };
  } else {
    if (
      !entry ||
      !sessionKey ||
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
    source = {
      version: 1,
      agentId: params.agentId,
      sessionKey,
      sessionId: entry.sessionId,
      ...(entry.lifecycleRevision !== undefined
        ? { lifecycleRevision: entry.lifecycleRevision }
        : {}),
      sourceRunId: params.sourceRunId,
      snapshot: { ...snapshot, scopes: intersectOperatorScopes(snapshot.scopes, authority.scopes) },
    };
  }
  return Buffer.byteLength(JSON.stringify(source), "utf8") <= 65_536
    ? freezeJsonSnapshot(source)
    : unavailable();
}
