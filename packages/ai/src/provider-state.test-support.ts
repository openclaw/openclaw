import { PROVIDER_STATE_SCOPE } from "./provider-types.js";
import { claimConversationProviderState } from "./session-resources.js";

/** Stream options of the conversation's writer run, which owns its provider state. */
export function writerState(sessionId: string) {
  return { [PROVIDER_STATE_SCOPE]: claimConversationProviderState(sessionId) };
}
