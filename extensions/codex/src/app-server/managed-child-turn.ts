import {
  isSubagentSessionKey,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { sha256Hex } from "openclaw/plugin-sdk/node-crypto-runtime";
import { buildCodexAppServerRuntimeFingerprint } from "./plugin-app-cache-key.js";

export function isCodexManagedChildAttempt(
  params: Pick<
    EmbeddedRunAttemptParamsV2,
    | "sessionKey"
    | "spawnedBy"
    | "disableMessageTool"
    | "privateCompletion"
    | "scheduledRuntimeAuthority"
    | "sessionPersistence"
  >,
): boolean {
  return (
    isSubagentSessionKey(params.sessionKey) &&
    Boolean(params.spawnedBy) &&
    params.disableMessageTool === true &&
    params.privateCompletion !== true &&
    params.sessionPersistence !== "detached" &&
    !params.scheduledRuntimeAuthority
  );
}

/** Correlates only the child launch, without sending host run ids or prompt text as metadata. */
export function codexManagedChildTurnReceipt(params: {
  runId: string;
  threadId: string;
  sessionId: string;
}): string {
  return sha256Hex(
    JSON.stringify([
      "openclaw:codex:managed-child-launch:v1",
      params.runId,
      params.threadId,
      params.sessionId,
    ]),
  );
}

/** Attests the exact socket and its authority for one managed run before a cold connection. */
export function codexManagedChildRecoveryFingerprint(params: {
  appServer: Parameters<typeof buildCodexAppServerRuntimeFingerprint>[0]["appServer"];
  sessionId: string;
  runId: string;
}): string {
  return sha256Hex(
    JSON.stringify([
      "openclaw:codex:managed-child-recovery:v1",
      // The shared-client cache key uses a process-local HMAC. Recovery spans processes.
      buildCodexAppServerRuntimeFingerprint({ appServer: params.appServer }),
      params.appServer.start.tlsPeerCertificate ?? null,
      params.sessionId,
      params.runId,
    ]),
  );
}
