import type { FinalizedMsgContext } from "../templating.js";
export type FinalizeInboundContextOptions = {
    forceBodyForAgent?: boolean;
    forceBodyForCommands?: boolean;
    forceChatType?: boolean;
    forceConversationLabel?: boolean;
};
export declare function finalizeInboundContext<T extends Record<string, unknown>>(ctx: T, opts?: FinalizeInboundContextOptions): T & FinalizedMsgContext;
