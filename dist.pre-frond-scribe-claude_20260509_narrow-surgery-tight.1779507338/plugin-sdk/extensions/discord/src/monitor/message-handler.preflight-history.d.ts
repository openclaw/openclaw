import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";
export declare function buildDiscordPreflightHistoryEntry(params: {
    isGuildMessage: boolean;
    historyLimit: number;
    message: DiscordMessagePreflightContext["message"];
    senderLabel: string;
}): HistoryEntry | undefined;
