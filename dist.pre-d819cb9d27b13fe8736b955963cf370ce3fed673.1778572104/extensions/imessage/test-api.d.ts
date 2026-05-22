import { n as ChannelOutboundAdapter } from "../../outbound.types-Bzt2qlxn.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-BoZgMdCh.js";
import { n as ChannelPlugin } from "../../types.public-Bp4rl8_W.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };