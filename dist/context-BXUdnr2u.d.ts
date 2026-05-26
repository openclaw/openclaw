import { d as ContextVisibilityMode } from "./types.base-DS--yneR.js";
import { n as InboundEventKind } from "./input-provenance-DgsxhTbk.js";
import { i as CommandTurnContext, t as FinalizedMsgContext } from "./templating-DbSpLCuR.js";
import { A as SenderFacts, D as RouteFacts, E as ReplyPlanFacts, S as MessageFacts, j as SupplementalContextFacts, t as AccessFacts, v as CommandFacts, x as InboundMediaFacts, y as ConversationFacts } from "./types-C4IQ1Uoz.js";

//#region src/channels/inbound-event/context.d.ts
type BuildChannelInboundEventContextParams = {
  channel: string;
  accountId?: string;
  provider?: string;
  surface?: string;
  messageId?: string;
  messageIdFull?: string;
  timestamp?: number;
  from: string;
  sender: SenderFacts;
  conversation: ConversationFacts;
  route: RouteFacts;
  reply: ReplyPlanFacts;
  message: MessageFacts;
  access?: AccessFacts;
  command?: CommandFacts;
  commandTurn?: CommandTurnContext;
  media?: InboundMediaFacts[];
  supplemental?: SupplementalContextFacts;
  contextVisibility?: ContextVisibilityMode;
  extra?: Record<string, unknown>;
};
type BuiltChannelInboundEventContext = FinalizedMsgContext & {
  Body: string;
  BodyForAgent: string;
  BodyForCommands: string;
  ChatType: ConversationFacts["kind"];
  CommandAuthorized: boolean;
  CommandBody: string;
  From: string;
  RawBody: string;
  SessionKey: string;
  To: string;
  InboundEventKind: InboundEventKind;
};
declare function filterChannelInboundSupplementalContext(params: {
  supplemental?: SupplementalContextFacts;
  contextVisibility?: ContextVisibilityMode;
}): SupplementalContextFacts | undefined;
declare function buildChannelInboundEventContext(params: BuildChannelInboundEventContextParams): BuiltChannelInboundEventContext;
//#endregion
export { filterChannelInboundSupplementalContext as i, BuiltChannelInboundEventContext as n, buildChannelInboundEventContext as r, BuildChannelInboundEventContextParams as t };