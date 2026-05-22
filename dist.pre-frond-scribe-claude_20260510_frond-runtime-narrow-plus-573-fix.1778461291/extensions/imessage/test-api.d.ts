import { n as ChannelOutboundAdapter } from "../../outbound.types-DfHbN8bI.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-CQScvK0N.js";
import { n as ChannelPlugin } from "../../types.public-BMrZTIWg.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };