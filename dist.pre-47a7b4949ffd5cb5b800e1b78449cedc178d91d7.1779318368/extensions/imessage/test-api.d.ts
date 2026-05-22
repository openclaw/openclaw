import { n as ChannelOutboundAdapter } from "../../outbound.types-CEuSkQTG.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-DzzzLcdL.js";
import { n as ChannelPlugin } from "../../types.public-BdkEyxaN.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };