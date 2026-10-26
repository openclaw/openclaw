import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { RestartRecoveryOperatorSource } from "../gateway/operator-run-recovery-source.codec.js";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isIncognitoSessionKey,
} from "../routing/session-key.js";
import { isAgentHarnessSessionKey } from "../sessions/agent-harness-session-key.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import type { RequesterOrigin } from "./requester-origin.js";

type OperatorInputRecoverySourceParams = {
  authority?: AdmittedRunOperatorAuthority;
  entry: InternalSessionEntry;
  agentId: string;
  sessionKey: string;
  sourceRunId: string;
};

/** Original admitted operator evidence; each recovery owner still re-admits its own work. */
export function createOperatorInputRecoverySource(
  params: OperatorInputRecoverySourceParams,
): RestartRecoveryOperatorSource | undefined {
  const { authority, entry, sessionKey } = params;
  if (!authority || entry.incognito || isIncognitoSessionKey(sessionKey)) {
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

/** Capture the admitted turn; restart ownership is selected from its exact active run. */
export function createRestartRecoveryOperatorSource(
  params: OperatorInputRecoverySourceParams & {
    inputProvenance?: InputProvenance;
    requesterOrigin?: RequesterOrigin;
  },
): RestartRecoveryOperatorSource | undefined {
  const { entry, sessionKey } = params;
  const requesterSettle =
    params.inputProvenance?.kind === "inter_session" &&
    params.inputProvenance.sourceTool === "subagent_settle" &&
    params.inputProvenance.sourceChannel === "internal" &&
    params.sourceRunId.startsWith("announce:requester-settle:") &&
    Boolean(params.inputProvenance.sourceSessionKey?.trim());
  // Native child sessions can admit later independent turns under this source.
  // Cron, ACP, plugins, and harnesses retain their own continuation contracts.
  if (
    entry.acp ||
    entry.pluginOwnerId ||
    entry.cronRunContinuation ||
    (params.inputProvenance &&
      params.inputProvenance.kind !== "external_user" &&
      !(
        (params.inputProvenance.kind === "inter_session" ||
          (params.inputProvenance.kind === "internal_system" &&
            params.inputProvenance.sourceTool === "session_goal_continue")) &&
        (params.requesterOrigin
          ? params.requesterOrigin.operatorProfileId === params.authority?.profileId
          : requesterSettle)
      )) ||
    isCronSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey) ||
    isAgentHarnessSessionKey(sessionKey)
  ) {
    return undefined;
  }
  return createOperatorInputRecoverySource(params);
}
