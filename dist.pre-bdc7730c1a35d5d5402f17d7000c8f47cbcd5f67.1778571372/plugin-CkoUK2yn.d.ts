import { n as ChannelPlugin } from "./types.public-CH2hYFDc.js";
import { t as TwitchAccountConfig } from "./types-qGj1s9L-.js";

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