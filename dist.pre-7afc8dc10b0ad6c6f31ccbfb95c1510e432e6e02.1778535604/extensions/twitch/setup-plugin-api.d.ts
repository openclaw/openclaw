import { n as ChannelPlugin } from "../../types.public-D_xOTs5v.js";
import { t as TwitchAccountConfig } from "../../types-CGFu2phK.js";

//#region extensions/twitch/src/setup-surface.d.ts
type ResolvedTwitchAccount = TwitchAccountConfig & {
  accountId?: string | null;
};
declare const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount>;
//#endregion
export { twitchSetupPlugin };