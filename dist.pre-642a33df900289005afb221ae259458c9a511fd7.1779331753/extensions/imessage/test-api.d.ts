import { n as ChannelOutboundAdapter } from "../../outbound.types-Cgk5Z_wx.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-C6a4QJNn.js";
import { n as ChannelPlugin } from "../../types.public-0ZbPwK4W.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };