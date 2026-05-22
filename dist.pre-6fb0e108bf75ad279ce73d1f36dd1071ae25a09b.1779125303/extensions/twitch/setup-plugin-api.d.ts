import { n as ChannelPlugin } from "../../types.public-Cx-Og-oG.js";
import { t as TwitchAccountConfig } from "../../types-YJnSKTIa.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };