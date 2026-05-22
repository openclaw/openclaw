import { n as ChannelOutboundAdapter } from "../../outbound.types-DsiI6f93.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-BDQOD1ST.js";
import { n as ChannelPlugin } from "../../types.public-D-nwYThg.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };