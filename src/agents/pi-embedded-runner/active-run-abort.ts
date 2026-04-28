import { abortReplyRunBySessionId } from "../../auto-reply/reply/reply-run-registry.js";
import { ACTIVE_EMBEDDED_RUNS } from "./run-state.js";

export function abortEmbeddedPiRunBySessionId(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    return abortReplyRunBySessionId(sessionId);
  }
  handle.abort();
  return true;
}
