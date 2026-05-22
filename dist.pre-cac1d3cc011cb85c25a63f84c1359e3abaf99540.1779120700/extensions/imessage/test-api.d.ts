import { n as ChannelOutboundAdapter } from "../../outbound.types-Bo4urJG2.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-zIW2Gjsy.js";
import { n as ChannelPlugin } from "../../types.public-JfHpZqwR.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };