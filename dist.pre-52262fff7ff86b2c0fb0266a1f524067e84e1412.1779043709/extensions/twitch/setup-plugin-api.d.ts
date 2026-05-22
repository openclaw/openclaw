import { n as ChannelPlugin } from "../../types.public-Dl9p3tAM.js";
import { t as TwitchAccountConfig } from "../../types-B3dFNhXo.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };