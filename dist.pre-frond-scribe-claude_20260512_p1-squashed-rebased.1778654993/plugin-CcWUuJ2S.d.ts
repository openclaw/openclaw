import { n as ChannelPlugin } from "./types.public-D-nwYThg.js";
import { t as TwitchAccountConfig } from "./types-BjQF-3LC.js";

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