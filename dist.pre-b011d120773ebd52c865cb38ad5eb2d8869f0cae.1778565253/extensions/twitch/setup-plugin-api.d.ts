import { n as ChannelPlugin } from "../../types.public-CH2hYFDc.js";
import { t as TwitchAccountConfig } from "../../types-CITgYJ8N.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };