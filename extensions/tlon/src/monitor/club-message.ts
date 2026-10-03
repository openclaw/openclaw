// Tlon club messages use the club UUID as authority and keep the author display-only.
import type { ChannelIngressContextBinding } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { TlonIngressLifecycle } from "./ingress.js";
import { resolveTlonMessageIngress } from "./utils.js";

export async function prepareAnonymousClubMessage(params: {
  accountId: string;
  clubId: string;
  claimedAuthorShip: string;
  messageId: string;
  messageContent: unknown;
  rawText: string;
  timestamp: number;
  turnAdoptionLifecycle?: TlonIngressLifecycle;
  resolveAllCites: (content: unknown) => Promise<string>;
}) {
  return {
    messageText: (await params.resolveAllCites(params.messageContent)) + params.rawText,
    messageId: params.messageId,
    senderShip: params.claimedAuthorShip,
    messageContent: params.messageContent,
    isGroup: true,
    clubId: params.clubId,
    senderAuthenticated: false,
    timestamp: params.timestamp,
    turnAdoptionLifecycle: params.turnAdoptionLifecycle,
    resolveChannelIngress: async (contextBinding: ChannelIngressContextBinding) =>
      await resolveTlonMessageIngress({
        senderShip: params.clubId,
        accountId: params.accountId,
        conversation: { kind: "group", id: params.clubId },
        allowFrom: [],
        groupPolicy: "open",
        contextBinding,
      }),
  };
}
