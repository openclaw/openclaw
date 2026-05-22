import { n as ChannelOutboundAdapter } from "../../outbound.types-GcP9rxun.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-CcKckzwX.js";
import { n as ChannelPlugin } from "../../types.public-DAjiQLbJ.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };