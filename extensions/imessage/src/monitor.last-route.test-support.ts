// Imessage tests share monitor.last-route fixtures across sibling suites.
import type { IMessagePayload } from "./monitor/types.js";
import { setCachedIMessagePrivateApiStatus } from "./private-api-status.js";

export const DEFAULT_SENDER = "+15550001111";
const ANCHOR_REPAIR_GUID = "11111111-1111-4111-8111-111111111111";

export function setAvailablePrivateApiMethods(rpcMethods: string[]): void {
  setCachedIMessagePrivateApiStatus("imsg", {
    available: true,
    v2Ready: true,
    selectors: {},
    rpcMethods,
  });
}

export function createInboundMessage(
  message: Pick<IMessagePayload, "id" | "guid" | "text"> &
    Partial<
      Pick<
        IMessagePayload,
        | "chat_id"
        | "chat_guid"
        | "chat_identifier"
        | "sender"
        | "is_from_me"
        | "is_group"
        | "created_at"
        | "destination_caller_id"
        | "reply_to_guid"
      >
    >,
): IMessagePayload {
  return {
    id: message.id,
    guid: message.guid,
    chat_id: message.chat_id ?? 123,
    chat_guid: message.chat_guid,
    chat_identifier: message.chat_identifier,
    sender: message.sender ?? DEFAULT_SENDER,
    is_from_me: message.is_from_me ?? false,
    text: message.text,
    is_group: message.is_group ?? false,
    created_at: message.created_at ?? new Date().toISOString(),
    destination_caller_id: message.destination_caller_id,
    reply_to_guid: message.reply_to_guid,
  };
}

export function createAnchorlessDirectPair(id: number, text: string, isFromMe: boolean) {
  return {
    notification: {
      id,
      guid: ANCHOR_REPAIR_GUID,
      chat_id: 0,
      chat_guid: "",
      chat_identifier: "",
      sender: "+15550000001",
      destination_caller_id: "+15550000001",
      is_from_me: false,
      is_group: false,
      service: "iMessage",
      text,
      created_at: new Date().toISOString(),
    },
    history: {
      id,
      guid: ANCHOR_REPAIR_GUID,
      chat_id: 42,
      chat_guid: "iMessage;-;+15550000002",
      chat_identifier: "+15550000002",
      sender: "+15550000002",
      destination_caller_id: "+15550000001",
      is_from_me: isFromMe,
      is_group: false,
      service: "iMessage",
    },
  };
}
