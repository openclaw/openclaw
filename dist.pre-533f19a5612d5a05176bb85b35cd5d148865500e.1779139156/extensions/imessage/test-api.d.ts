import { n as ChannelOutboundAdapter } from "../../outbound.types-OtuBniOT.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-1gJzFdXJ.js";
import { n as ChannelPlugin } from "../../types.public-oY5Zsold.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };