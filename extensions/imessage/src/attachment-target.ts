// Resolves the native attachment selector for an outbound iMessage media send.
import { normalizeOptionalString as stringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  formatIMessageChatTarget,
  isDirectIMessageChatGuid,
  type IMessageService,
  type IMessageTarget,
  normalizeIMessageHandle,
} from "./targets.js";

export type IMessageAttachmentChatTarget = {
  /** Selector for one-shot `imsg send-attachment --chat`; null when no native route applies. */
  chatTarget: string | null;
  /**
   * True only for a resolved 1:1 chat. Group media must keep its dedicated native route
   * (openclaw/openclaw#86770); a direct chat may instead fall through to imsg's canonical send
   * RPC, which recovers a chat Messages.app no longer lists (openclaw/imsg#246, imsg#388).
   */
  directChat: boolean;
};

const NO_NATIVE_TARGET: IMessageAttachmentChatTarget = { chatTarget: null, directChat: false };

/**
 * Maps an outbound target onto the chat selector `imsg send-attachment` expects.
 *
 * `lookupChat` runs the read-only `imsg group --chat-id` resolution; its errors propagate so the
 * caller keeps owning the unsupported-command fallback decision.
 */
export async function resolveIMessageAttachmentChatTarget(params: {
  target: IMessageTarget;
  service: IMessageService | undefined;
  remoteHost: string | undefined;
  lookupChat: (chatId: number) => Promise<Record<string, unknown>>;
}): Promise<IMessageAttachmentChatTarget> {
  const { target, service, remoteHost } = params;
  if (target.kind === "chat_guid") {
    return { chatTarget: target.chatGuid, directChat: isDirectIMessageChatGuid(target.chatGuid) };
  }
  if (target.kind === "handle") {
    const rawHandle = target.to.trim();
    // Local imsg only accepts canonical handles; remote resolution accepts aliases.
    if (!remoteHost && !rawHandle.includes("@") && !rawHandle.startsWith("+")) {
      return NO_NATIVE_TARGET;
    }
    const normalizedHandle = normalizeIMessageHandle(target.to);
    if (!normalizedHandle) {
      return NO_NATIVE_TARGET;
    }
    const attachmentService = target.service !== "auto" ? target.service : service;
    const prefix =
      attachmentService === "sms" ? "SMS" : attachmentService === "imessage" ? "iMessage" : "any";
    // A handle selector names a participant, never an existing chat row, so it is not a
    // resolved direct chat here; #115006 already routes service-qualified handles to the RPC.
    return { chatTarget: `${prefix};-;${normalizedHandle}`, directChat: false };
  }
  if (remoteHost) {
    return {
      chatTarget:
        target.kind === "chat_identifier"
          ? target.chatIdentifier
          : formatIMessageChatTarget(target.chatId),
      directChat: false,
    };
  }
  if (target.kind === "chat_identifier") {
    return NO_NATIVE_TARGET;
  }
  const result = await params.lookupChat(target.chatId);
  const chatTarget = stringValue(result.guid) ?? stringValue(result.chat_guid) ?? null;
  return {
    chatTarget,
    directChat:
      chatTarget !== null && result.is_group !== true && isDirectIMessageChatGuid(chatTarget),
  };
}
