import { n as ChannelPlugin } from "../../types.public-hz1J9-y_.js";
import { t as TwitchAccountConfig } from "../../types-C_M6qjyW.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };