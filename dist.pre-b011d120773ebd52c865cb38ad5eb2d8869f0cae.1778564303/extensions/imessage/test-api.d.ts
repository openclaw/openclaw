import { n as ChannelOutboundAdapter } from "../../outbound.types-DgglYInj.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-D5GEzFhB.js";
import { n as ChannelPlugin } from "../../types.public-CH2hYFDc.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };