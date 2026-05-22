import { n as ChannelOutboundAdapter } from "../../outbound.types-B5xApU2S.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-DA-emjB6.js";
import { n as ChannelPlugin } from "../../types.public-Cx-Og-oG.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };