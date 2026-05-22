import { n as ChannelOutboundAdapter } from "../../outbound.types-CYxlkHkP.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-TY_PD3kg.js";
import { n as ChannelPlugin } from "../../types.public-CzfdpDjZ.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };