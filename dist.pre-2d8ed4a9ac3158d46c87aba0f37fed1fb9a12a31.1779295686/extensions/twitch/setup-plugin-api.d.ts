import { n as ChannelPlugin } from "../../types.public-BlA4mimK.js";
import { t as TwitchAccountConfig } from "../../types-C0UQ9Ii0.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };