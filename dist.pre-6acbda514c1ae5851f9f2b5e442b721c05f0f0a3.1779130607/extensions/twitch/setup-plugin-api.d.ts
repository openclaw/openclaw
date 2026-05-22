import { n as ChannelPlugin } from "../../types.public-CwqPONY3.js";
import { t as TwitchAccountConfig } from "../../types-DhIRZJ8K.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };