import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
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
function projectSessionForkRequester(context: SessionForkRequester): SessionForkRequester {
  const requester: SessionForkRequester = {};
  for (const field of REQUESTER_FIELDS) {
    if (context[field] !== undefined) {
      Object.assign(requester, { [field]: context[field] });
    }
  }
  return requester;
}

/**
 * The requester a stored user turn recorded: host-written sender facts and the captured
 * requester origin. Undefined when the turn recorded neither, so callers fall back to the
 * session's stored conversation facts.
 */
export function readSessionForkRequesterFromTurn(meta: unknown): SessionForkRequester | undefined {
  const record = asOptionalRecord(meta);
  const origin = asOptionalRecord(record?.requesterOrigin);
  if (!record || (!origin && typeof record.senderIsOwner !== "boolean" && !record.senderId)) {
    return undefined;
  }
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const channel = text(origin?.messageProvider);
  return projectSessionForkRequester({
    agentAccountId: text(origin?.accountId),
    messageProvider: channel,
    messageChannel: channel,
    groupId: text(origin?.groupId),
    groupChannel: text(origin?.groupChannel),
    groupSpace: text(origin?.groupSpace),
    senderId: text(origin?.senderId) ?? text(record.senderId),
    senderName: text(origin?.senderName) ?? text(record.senderName),
    senderUsername: text(origin?.senderUsername) ?? text(record.senderUsername),
    senderE164: text(origin?.senderE164),
    ...(typeof record.senderIsOwner === "boolean" ? { senderIsOwner: record.senderIsOwner } : {}),
  });
}
