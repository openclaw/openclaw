import { n as MsgContext } from "../../templating-B2YqU08i.js";
import { n as ChannelOutboundAdapter } from "../../outbound.types-DsiI6f93.js";
import { t as discordPlugin } from "../../channel-BA0cYQ3S.js";
import { t as __testing } from "../../thread-bindings.manager-BEazvsbX.js";
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
  UntrustedContext: string[] | undefined;
  Provider: string;
  Surface: string;
  WasMentioned: boolean;
  MessageSid: string;
  CommandAuthorized: boolean;
  OriginatingChannel: string;
  OriginatingTo: string;
} & Omit<MsgContext, "CommandAuthorized"> & {
  CommandAuthorized: boolean;
};
//#endregion
//#region extensions/discord/src/outbound-adapter.d.ts
declare const discordOutbound: ChannelOutboundAdapter;
//#endregion
export { buildFinalizedDiscordDirectInboundContext, discordOutbound, discordPlugin, __testing as discordThreadBindingTesting };