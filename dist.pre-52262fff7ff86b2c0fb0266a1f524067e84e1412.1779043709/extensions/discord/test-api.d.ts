import { n as MsgContext, o as CommandTurnContext } from "../../templating-COksQNte.js";
import { n as ChannelOutboundAdapter } from "../../outbound.types-Dn4sB4pn.js";
import { t as discordPlugin } from "../../channel-UUmiTKBk.js";
import { t as __testing } from "../../thread-bindings.manager-BmaiQIEj.js";
//#region extensions/discord/src/monitor/inbound-context.test-helpers.d.ts
declare function buildFinalizedDiscordDirectInboundContext(): {
  Body: string;
  BodyForAgent: string;
  RawBody: string;
  CommandBody: string;
  From: string;
  To: string;
  SessionKey: string;
  AccountId: string;
  ChatType: string;
  ConversationLabel: string;
  SenderName: string;
  SenderId: string;
  SenderUsername: string;
  GroupSystemPrompt: string | undefined;
  OwnerAllowFrom: string[] | undefined;
  UntrustedStructuredContext: {
    label: string;
    source?: string;
    type?: string;
    payload: unknown;
  }[] | undefined;
  Provider: string;
  Surface: string;
  WasMentioned: boolean;
  MessageSid: string;
  CommandAuthorized: boolean;
  OriginatingChannel: string;
  OriginatingTo: string;
} & Omit<MsgContext, "CommandAuthorized"> & {
  CommandAuthorized: boolean;
  CommandTurn?: CommandTurnContext;
};
//#endregion
//#region extensions/discord/src/outbound-adapter.d.ts
declare const discordOutbound: ChannelOutboundAdapter;
//#endregion
export { buildFinalizedDiscordDirectInboundContext, discordOutbound, discordPlugin, __testing as discordThreadBindingTesting };