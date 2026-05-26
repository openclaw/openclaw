import { n as ChannelOutboundAdapter } from "../../outbound.types-COmT4EQP.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-1gFCH89g.js";
import { n as ChannelPlugin } from "../../types.public-BfuQlAVf.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };