// The one place a stored Discord ingress frame becomes the Message constructor's
// APIMessage, shared by the claim-time codec (ingress.ts, whose decode hands it to
// preflight) and the stale policy (ingress-stale-policy.ts), so both read the same
// object under the same contract.
import type { APIMessage } from "discord-api-types/v10";

/**
 * A stored MESSAGE_CREATE frame as APIMessage. Callers first check the fields
 * they read themselves (the codec: id and channel_id; the stale policy: every
 * field APIMessage requires); Message reads the rest lazily, with defaults.
 */
export function asStoredDiscordMessage(rawMessage: object): APIMessage {
  // The codec serializes rawMessage as received, so its fields are the
  // APIMessage the gateway delivered.
  // SAFETY: the durable payload persists the gateway's MESSAGE_CREATE frame verbatim.
  return rawMessage as APIMessage;
}
