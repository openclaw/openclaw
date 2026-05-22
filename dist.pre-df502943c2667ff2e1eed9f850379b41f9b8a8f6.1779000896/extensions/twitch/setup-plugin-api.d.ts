import { n as ChannelPlugin } from "../../types.public-i4hJTC6b.js";
import { t as TwitchAccountConfig } from "../../types-C62PA8UM.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };