import { n as ChannelPlugin } from "../../types.public-C5MFEvPW.js";
import { t as TwitchAccountConfig } from "../../types-rZhE8Rfu.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };