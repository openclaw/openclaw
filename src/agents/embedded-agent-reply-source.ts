import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  copyReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";
import type { PersistedUserTurnMessage } from "../sessions/user-turn-transcript.types.js";
import type { UserTranscriptContext } from "./embedded-agent-runner/run/attempt-llm-boundary.types.js";

/** Snapshot the input consumed by this assistant, before later steering arrives. */
export function resolveAssistantReplySource(
  contexts: readonly UserTranscriptContext[] | undefined,
  channel: string | undefined,
): string | undefined {
  if (channel !== "telegram" || !contexts?.length) {
    return undefined;
  }
  const first = contexts[0]?.transcriptMessage;
  const last = contexts.at(-1)?.transcriptMessage;
  if (first?.role !== "user" || last?.role !== "user") {
    return undefined;
  }
  const firstUser: PersistedUserTurnMessage = first;
  const lastUser: PersistedUserTurnMessage = last;
  const firstTransport = asOptionalRecord(firstUser["__openclaw"]?.transport);
  const transport = asOptionalRecord(lastUser["__openclaw"]?.transport);
  const firstSender = asOptionalRecord(firstUser["__openclaw"]?.senderIdentity);
  const sender = asOptionalRecord(lastUser["__openclaw"]?.senderIdentity);
  if (
    (lastUser.provenance?.kind && lastUser.provenance.kind !== "external_user") ||
    transport?.channel !== "telegram" ||
    !transport.conversationRef ||
    transport.conversationRef !== firstTransport?.conversationRef ||
    sender?.accountId !== firstSender?.accountId ||
    typeof transport.messageId !== "string" ||
    !/^[1-9]\d{0,19}$/.test(transport.messageId)
  ) {
    return undefined;
  }
  return transport.messageId;
}

/** An implicit source does not override an explicit quote or quote suppression. */
export function withAssistantReplySource<T extends ReplyPayload>(payload: T, source?: string): T {
  if (
    !source ||
    payload.replyToCurrent === false ||
    (payload.replyToId && !payload.replyToCurrent) ||
    (payload.replyToTag && !payload.replyToCurrent)
  ) {
    return payload;
  }
  return setReplyPayloadMetadata(
    copyReplyPayloadMetadata(payload, { ...payload, replyToId: source }),
    { replyToIdExplicit: Boolean(payload.replyToCurrent || payload.replyToTag) },
  );
}
