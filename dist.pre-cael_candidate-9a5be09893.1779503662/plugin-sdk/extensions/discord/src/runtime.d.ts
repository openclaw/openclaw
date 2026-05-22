import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
type DiscordChannelRuntime = {
    messageActions?: typeof import("./channel-actions.js").discordMessageActions;
    sendMessageDiscord?: typeof import("./send.js").sendMessageDiscord;
};
export type DiscordRuntime = PluginRuntime & {
    channel: PluginRuntime["channel"] & {
        discord?: DiscordChannelRuntime;
    };
};
declare const setDiscordRuntime: (next: DiscordRuntime) => void, getOptionalDiscordRuntime: () => DiscordRuntime | null, getDiscordRuntime: () => DiscordRuntime;
export { getDiscordRuntime, getOptionalDiscordRuntime, setDiscordRuntime };
