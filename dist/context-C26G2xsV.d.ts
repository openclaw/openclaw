import { d as ContextVisibilityMode } from "./types.base-DCoxbfrn.js";
import { t as FinalizedMsgContext } from "./templating-BcdAlwzB.js";
import { O as SenderFacts, T as RouteFacts, _ as ConversationFacts, b as MessageFacts, k as SupplementalContextFacts, t as AccessFacts, w as ReplyPlanFacts, y as InboundMediaFacts } from "./types-Bi_1Er1P.js";

//#region src/channels/turn/context.d.ts
type BuildChannelTurnContextParams = {
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
  media?: InboundMediaFacts[];
  supplemental?: SupplementalContextFacts;
  contextVisibility?: ContextVisibilityMode;
  extra?: Record<string, unknown>;
};
type BuiltChannelTurnContext = FinalizedMsgContext & {
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
};
declare function filterChannelTurnSupplementalContext(params: {
  supplemental?: SupplementalContextFacts;
  contextVisibility?: ContextVisibilityMode;
}): SupplementalContextFacts | undefined;
declare function buildChannelTurnContext(params: BuildChannelTurnContextParams): BuiltChannelTurnContext;
//#endregion
export { filterChannelTurnSupplementalContext as i, BuiltChannelTurnContext as n, buildChannelTurnContext as r, BuildChannelTurnContextParams as t };