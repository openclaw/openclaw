import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { callGateway as GatewayCaller } from "../../../gateway/call.js";
import { bindGatewayLifecycleRequest } from "../../../gateway/server-recovery-runtime-context.js";
import {
  isIncognitoSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../../routing/session-key.js";
import { withSubagentSessionSource } from "../spawn/subagent-session-source.js";
export { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
export { getRuntimeConfig } from "../../../config/config.js";
export {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "../../../config/sessions.js";

export function readSubagentSessionEntry(
  storePath: string,
  sessionKey: string,
  explicitAgentId?: string,
) {
  const agentId = explicitAgentId ?? resolveAgentIdFromSessionKey(sessionKey);
  return withSubagentSessionSource({ agentId, storePath, sessionKey }, async (source) =>
    source
      ? source.actor.snapshot(source.authority)?.entry
      : isIncognitoSessionKey(sessionKey)
        ? undefined
        : readSessionEntryReadOnlyInWorker({ storePath, sessionKey, agentId }),
  );
}
export const callSubagentLifecycleGateway: typeof GatewayCaller = (request) =>
  bindGatewayLifecycleRequest()(request);
export { readSessionMessagesAsync } from "../../../gateway/session-transcript-readers.js";
export {
  isEmbeddedAgentRunActive,
  waitForEmbeddedAgentRunEnd,
} from "../../embedded-agent-runner/runs.js";
