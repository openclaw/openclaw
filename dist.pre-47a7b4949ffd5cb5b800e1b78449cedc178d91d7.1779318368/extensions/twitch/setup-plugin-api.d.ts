import { n as ChannelPlugin } from "../../types.public-BdkEyxaN.js";
import { t as TwitchAccountConfig } from "../../types-C3b4EExc.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };