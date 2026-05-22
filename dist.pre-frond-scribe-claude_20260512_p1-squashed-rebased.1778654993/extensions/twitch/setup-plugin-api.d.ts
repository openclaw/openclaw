import { n as ChannelPlugin } from "../../types.public-D-nwYThg.js";
import { t as TwitchAccountConfig } from "../../types-BjQF-3LC.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };