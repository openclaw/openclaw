import type { MsgContext } from "../auto-reply/templating.js";
export declare function normalizeExplicitDiscordSessionKey(sessionKey: string, ctx: Pick<MsgContext, "ChatType" | "From" | "SenderId">): string;
