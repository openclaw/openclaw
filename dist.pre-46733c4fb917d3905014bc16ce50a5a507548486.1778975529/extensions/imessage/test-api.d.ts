import { n as ChannelOutboundAdapter } from "../../outbound.types-u93QSb9q.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-BHltg72J.js";
import { n as ChannelPlugin } from "../../types.public-DObS_ia-.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };