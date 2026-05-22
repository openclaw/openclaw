import { n as ChannelPlugin } from "../../types.public-Bp4rl8_W.js";
import { t as TwitchAccountConfig } from "../../types-BqzsvDJp.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };