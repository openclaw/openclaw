import { n as ChannelOutboundAdapter } from "../../outbound.types-D7agCOHK.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-BkmTlRzr.js";
import { n as ChannelPlugin } from "../../types.public-B2Ho5PN_.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };