import { n as ChannelPlugin } from "../../types.public-D-nwYThg.js";
//#region extensions/msteams/src/channel.setup.d.ts
type ResolvedMSTeamsAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};
declare const msteamsSetupPlugin: ChannelPlugin<ResolvedMSTeamsAccount>;
//#endregion
export { msteamsSetupPlugin };