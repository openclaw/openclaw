import { n as ChannelPlugin } from "../../types.public-CzfdpDjZ.js";
import { t as TwitchAccountConfig } from "../../types-Bhgu6aA6.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };