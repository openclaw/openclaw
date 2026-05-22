import { n as ChannelOutboundAdapter } from "../../outbound.types-HXKmv1kV.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-Dsbrk0cK.js";
import { n as ChannelPlugin } from "../../types.public--zAg7SxY.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };