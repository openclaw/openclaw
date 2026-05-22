import { n as ChannelOutboundAdapter } from "../../outbound.types-DKGVr4LC.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-DiLRQ15F.js";
import { n as ChannelPlugin } from "../../types.public-BGobpRnR.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };