import { n as ChannelOutboundAdapter } from "../../outbound.types-DuRB2RNl.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-DMG-czl3.js";
import { n as ChannelPlugin } from "../../types.public-CwqPONY3.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };