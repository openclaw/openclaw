import { t as FinalizedMsgContext } from "./templating-DbSpLCuR.js";

//#region src/auto-reply/reply/inbound-context.d.ts
type FinalizeInboundContextOptions = {
  forceBodyForAgent?: boolean;
  forceBodyForCommands?: boolean;
  forceChatType?: boolean;
  forceConversationLabel?: boolean;
};
declare function finalizeInboundContext<T extends Record<string, unknown>>(ctx: T, opts?: FinalizeInboundContextOptions): T & FinalizedMsgContext;
//#endregion
export { finalizeInboundContext as t };