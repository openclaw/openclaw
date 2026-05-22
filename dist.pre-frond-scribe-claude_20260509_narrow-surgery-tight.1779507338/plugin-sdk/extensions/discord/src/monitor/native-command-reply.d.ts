import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import type { ButtonInteraction, CommandInteraction, StringSelectMenuInteraction } from "../internal/discord.js";
export declare const DISCORD_EMPTY_VISIBLE_REPLY_WARNING = "\u26A0\uFE0F Command produced no visible reply.";
export declare function isDiscordUnknownInteraction(error: unknown): boolean;
export declare function hasRenderableReplyPayload(payload: ReplyPayload): boolean;
export declare function safeDiscordInteractionCall<T>(label: string, fn: () => Promise<T>): Promise<T | null>;
export declare function deliverDiscordInteractionReply(params: {
    interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
    payload: ReplyPayload;
    mediaLocalRoots?: readonly string[];
    textLimit: number;
    maxLinesPerMessage?: number;
    preferFollowUp: boolean;
    responseEphemeral?: boolean;
    chunkMode: "length" | "newline";
}): Promise<void>;
