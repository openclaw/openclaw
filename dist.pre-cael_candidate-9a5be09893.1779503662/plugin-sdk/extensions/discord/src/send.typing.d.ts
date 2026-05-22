import type { DiscordReactOpts } from "./send.types.js";
export declare function sendTypingDiscord(channelId: string, opts: DiscordReactOpts): Promise<{
    ok: boolean;
    channelId: string;
}>;
