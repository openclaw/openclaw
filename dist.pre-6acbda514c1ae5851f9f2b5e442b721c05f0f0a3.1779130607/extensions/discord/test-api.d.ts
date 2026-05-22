import { n as MsgContext, o as CommandTurnContext } from "../../templating-8_WokN_0.js";
import { n as ChannelOutboundAdapter } from "../../outbound.types-DuRB2RNl.js";
import { t as discordPlugin } from "../../channel-5TdXN0ME.js";
import { i as testing } from "../../thread-bindings.manager-Dmipq6kW.js";
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
export { buildFinalizedDiscordDirectInboundContext, discordOutbound, discordPlugin, testing as discordThreadBindingTesting };