import { n as ChannelOutboundAdapter } from "../../outbound.types-IRn7e6X5.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-gexONR-2.js";
import { n as ChannelPlugin } from "../../types.public-D_xOTs5v.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };