import { n as ChannelOutboundAdapter } from "../../outbound.types-_qtghrWY.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-DrB_kWzl.js";
import { n as ChannelPlugin } from "../../types.public-B24V6qkJ.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };