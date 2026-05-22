import { n as ChannelPlugin } from "../../types.public-CH2hYFDc.js";
import { t as TwitchAccountConfig } from "../../types-qGj1s9L-.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };