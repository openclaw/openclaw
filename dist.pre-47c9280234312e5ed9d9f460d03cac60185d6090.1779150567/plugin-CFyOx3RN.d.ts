import { n as ChannelPlugin } from "./types.public-B24V6qkJ.js";
import { t as TwitchAccountConfig } from "./types-DNl9FAAb.js";

//#region extensions/twitch/src/plugin.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
/**
 * Twitch channel plugin.
 *
 * Implements the ChannelPlugin interface to provide Twitch chat integration
 * for OpenClaw. Supports message sending, receiving, access control, and
 * status monitoring.
 */
declare const twitchPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchPlugin as t };