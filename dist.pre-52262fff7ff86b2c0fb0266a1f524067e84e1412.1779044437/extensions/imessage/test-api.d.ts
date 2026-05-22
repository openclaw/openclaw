import { n as ChannelOutboundAdapter } from "../../outbound.types-Dn4sB4pn.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-CgjRAtD6.js";
import { n as ChannelPlugin } from "../../types.public-DA73dcyy.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };