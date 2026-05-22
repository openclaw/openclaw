import { n as ChannelOutboundAdapter } from "../../outbound.types-BK1BT_uT.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-yC1NCFUF.js";
import { n as ChannelPlugin } from "../../types.public-hz1J9-y_.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };