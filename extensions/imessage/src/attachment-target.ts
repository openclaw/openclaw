import {
  formatIMessageChatTarget,
  inferIMessageTargetChatType,
  type IMessageService,
  type IMessageTarget,
  normalizeIMessageHandle,
} from "./targets.js";

export type IMessageSendTransport = "auto" | "bridge" | "applescript";

/**
 * Picks the chat a one-shot `imsg send-attachment` should use, or null when the media belongs on
 * imsg's canonical `send` RPC instead. That RPC resolves handles and recovers a direct chat whose
 * chat.db GUID Messages no longer lists (imsg#246); send-attachment's AppleScript fallback cannot
 * (imsg#388), so ordinary direct-chat media uses `send` too. Group media, native voice, explicit
 * bridge and remote hosts keep the native attachment route.
 */
export async function resolveIMessageAttachmentChat(params: {
  target: IMessageTarget;
  service: IMessageService | undefined;
  sendTransport: IMessageSendTransport;
  remoteHost: string | undefined;
  audioAsVoice: boolean | undefined;
  lookupChatGuid: (chatId: number) => Promise<string | null>;
}): Promise<string | null> {
  const { target, service, sendTransport, remoteHost, audioAsVoice } = params;
  const canonicalSend = !audioAsVoice && sendTransport !== "bridge";
  if (canonicalSend && target.kind === "handle" && (service === "sms" || service === "imessage")) {
    return null;
  }
  if (remoteHost && sendTransport === "applescript") {
    return null;
  }
  let chat: string | null = null;
  if (target.kind === "chat_guid") {
    chat = target.chatGuid;
  } else if (target.kind === "handle") {
    const rawHandle = target.to.trim();
    // Local imsg only accepts canonical handles; remote resolution accepts aliases.
    if (remoteHost || rawHandle.includes("@") || rawHandle.startsWith("+")) {
      const normalizedHandle = normalizeIMessageHandle(target.to);
      if (normalizedHandle) {
        const attachmentService = target.service !== "auto" ? target.service : service;
        chat = `${attachmentService === "sms" ? "SMS" : attachmentService === "imessage" ? "iMessage" : "any"};-;${normalizedHandle}`;
      }
    }
    return chat;
  } else if (remoteHost) {
    return target.kind === "chat_identifier"
      ? target.chatIdentifier
      : formatIMessageChatTarget(target.chatId);
  } else if (target.kind === "chat_id") {
    chat = await params.lookupChatGuid(target.chatId);
  }
  if (
    chat &&
    canonicalSend &&
    !remoteHost &&
    inferIMessageTargetChatType(`chat_guid:${chat}`) === "direct"
  ) {
    return null;
  }
  return chat;
}
