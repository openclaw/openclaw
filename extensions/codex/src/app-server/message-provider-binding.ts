import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { normalizeMessageChannel } from "openclaw/plugin-sdk/routing";

// Matches INTERNAL_MESSAGE_CHANNEL in src/utils/message-channel-constants.ts; the
// constant and its helper are intentionally not part of the public plugin SDK.
const INTERNAL_MESSAGE_CHANNEL = "webchat";

function isInternalChannel(raw?: string | null): boolean {
  return normalizeMessageChannel(raw) === INTERNAL_MESSAGE_CHANNEL;
}

/** Detects internal turns that are not bound to a real user conversation. */
function isInternalCodexMessageTurn(
  params: Pick<EmbeddedRunAttemptParams, "trigger" | "inputProvenance">,
): boolean {
  if (params.inputProvenance?.kind === "inter_session") {
    return true;
  }
  return params.trigger === "heartbeat" || params.trigger === "cron";
}

/** Returns the canonical channel used for Codex message routing and receipts. */
export function resolveCodexMessageToolProvider(
  params: Pick<
    EmbeddedRunAttemptParams,
    "messageChannel" | "messageProvider" | "trigger" | "inputProvenance"
  >,
): string | undefined {
  const provider = params.messageChannel ?? params.messageProvider;
  // Internal turns use `webchat` as transport metadata, not as a conversation
  // binding. Keeping it would deny autonomous cross-provider notifications.
  if (isInternalChannel(provider) && isInternalCodexMessageTurn(params)) {
    return undefined;
  }
  return provider;
}
