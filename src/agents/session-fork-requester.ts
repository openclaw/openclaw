import type { EmbeddedForegroundPromptContext } from "./embedded-agent-runner/run/params.js";

const REQUESTER_FIELDS = [
  "agentAccountId",
  "messageProvider",
  "messageChannel",
  "groupId",
  "groupChannel",
  "groupSpace",
  "spawnedBy",
  "senderId",
  "senderName",
  "senderUsername",
  "senderE164",
  "senderIsOwner",
] as const;

/**
 * Who asked for the finished turn: the sender, owner flag, group and channel that tool policy
 * resolves against. The stored session does not record them, so a fork carries them to check
 * the requester's current policy again when it runs.
 */
export type SessionForkRequester = Pick<
  EmbeddedForegroundPromptContext,
  (typeof REQUESTER_FIELDS)[number]
>;

/** Copies only the requester fields, never the turn's live capabilities. */
export function projectSessionForkRequester(context: SessionForkRequester): SessionForkRequester {
  const requester: SessionForkRequester = {};
  for (const field of REQUESTER_FIELDS) {
    if (context[field] !== undefined) {
      Object.assign(requester, { [field]: context[field] });
    }
  }
  return requester;
}
