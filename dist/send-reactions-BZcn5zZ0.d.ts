import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/signal/src/send-reactions.d.ts
type SignalReactionOpts = {
  cfg: OpenClawConfig;
  baseUrl?: string;
  account?: string;
  accountId?: string;
  timeoutMs?: number;
  targetAuthor?: string;
  targetAuthorUuid?: string;
  groupId?: string;
};
type SignalReactionResult = {
  ok: boolean;
  timestamp?: number;
};
/**
 * Send a Signal reaction to a message
 * @param recipient - UUID or E.164 phone number of the message author
 * @param targetTimestamp - Message ID (timestamp) to react to
 * @param emoji - Emoji to react with
 * @param opts - Optional account/connection overrides
 */
declare function sendReactionSignal(recipient: string, targetTimestamp: number, emoji: string, opts: SignalReactionOpts): Promise<SignalReactionResult>;
/**
 * Remove a Signal reaction from a message
 * @param recipient - UUID or E.164 phone number of the message author
 * @param targetTimestamp - Message ID (timestamp) to remove reaction from
 * @param emoji - Emoji to remove
 * @param opts - Optional account/connection overrides
 */
declare function removeReactionSignal(recipient: string, targetTimestamp: number, emoji: string, opts: SignalReactionOpts): Promise<SignalReactionResult>;
//#endregion
export { sendReactionSignal as i, SignalReactionResult as n, removeReactionSignal as r, SignalReactionOpts as t };