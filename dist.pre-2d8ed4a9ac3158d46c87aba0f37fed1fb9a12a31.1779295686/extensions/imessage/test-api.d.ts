import { n as ChannelOutboundAdapter } from "../../outbound.types-CaslTlwW.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-remGx4m5.js";
import { n as ChannelPlugin } from "../../types.public-BlA4mimK.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };