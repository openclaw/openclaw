import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { callGateway as GatewayCaller } from "../../../gateway/call.js";
/**
 * Runtime dependency barrel for subagent announcement/output collection.
 *
 * Keeping these imports behind one module lets tests replace gateway/session
 * IO without changing the announce logic itself.
 */
import { bindGatewayLifecycleRequest } from "../../../gateway/server-recovery-runtime-context.js";
export { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
export { getRuntimeConfig } from "../../../config/config.js";
export {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "../../../config/sessions.js";

export function readSubagentSessionEntry(storePath: string, sessionKey: string) {
  return loadSessionEntry({ storePath, sessionKey });
}
export const callSubagentLifecycleGateway: typeof GatewayCaller = (request) =>
  bindGatewayLifecycleRequest()(request);
export { readSessionMessagesAsync } from "../../../gateway/session-transcript-readers.js";
export {
  isEmbeddedAgentRunActive,
  waitForEmbeddedAgentRunEnd,
} from "../../embedded-agent-runner/runs.js";
