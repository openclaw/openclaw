import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { o as GroupToolPolicyConfig } from "./types.tools-BpgZArJS.js";
import { a as ParsedChatTarget, n as ChatSenderAllowParams } from "./channel-targets-DVKc1lQ7.js";

//#region extensions/imessage/src/group-policy.d.ts
type IMessageGroupContext = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};
declare function resolveIMessageGroupRequireMention(params: IMessageGroupContext): boolean;
declare function resolveIMessageGroupToolPolicy(params: IMessageGroupContext): GroupToolPolicyConfig | undefined;
//#endregion
//#region extensions/imessage/src/targets.d.ts
type IMessageService = "imessage" | "sms" | "auto";
type IMessageTarget = {
  kind: "chat_id";
  chatId: number;
} | {
  kind: "chat_guid";
  chatGuid: string;
} | {
  kind: "chat_identifier";
  chatIdentifier: string;
} | {
  kind: "handle";
  to: string;
  service: IMessageService;
};
type IMessageAllowTarget = ParsedChatTarget | {
  kind: "handle";
  handle: string;
};
declare function normalizeIMessageHandle(raw: string): string;
declare function parseIMessageTarget(raw: string): IMessageTarget;
declare function looksLikeIMessageExplicitTargetId(raw: string): boolean;
declare function inferIMessageTargetChatType(raw: string): "direct" | "group" | undefined;
declare function parseIMessageAllowTarget(raw: string): IMessageAllowTarget;
declare function isAllowedIMessageSender(params: ChatSenderAllowParams): boolean;
declare function formatIMessageChatTarget(chatId?: number | null): string;
//#endregion
export { inferIMessageTargetChatType as a, normalizeIMessageHandle as c, resolveIMessageGroupRequireMention as d, resolveIMessageGroupToolPolicy as f, formatIMessageChatTarget as i, parseIMessageAllowTarget as l, IMessageService as n, isAllowedIMessageSender as o, IMessageTarget as r, looksLikeIMessageExplicitTargetId as s, IMessageAllowTarget as t, parseIMessageTarget as u };