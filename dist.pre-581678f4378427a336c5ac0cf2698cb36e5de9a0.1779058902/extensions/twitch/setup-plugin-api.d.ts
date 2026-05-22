import { n as ChannelPlugin } from "../../types.public-Dc4Eenvd.js";
import { t as TwitchAccountConfig } from "../../types-BgfaPWYl.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };