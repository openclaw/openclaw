import { n as ChannelPlugin } from "../../types.public-BMrZTIWg.js";
import { t as TwitchAccountConfig } from "../../types-BmVx_5Im.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };