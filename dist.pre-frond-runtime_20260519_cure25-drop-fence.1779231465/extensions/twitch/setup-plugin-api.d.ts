import { n as ChannelPlugin } from "../../types.public-B24V6qkJ.js";
import { t as TwitchAccountConfig } from "../../types-DNl9FAAb.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };