import { n as ChannelPlugin } from "../../types.public-oY5Zsold.js";
import { t as TwitchAccountConfig } from "../../types-C_nfU090.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };