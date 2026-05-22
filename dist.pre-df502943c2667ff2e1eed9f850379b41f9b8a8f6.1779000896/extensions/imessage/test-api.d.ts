import { n as ChannelOutboundAdapter } from "../../outbound.types-Bg2PsyCs.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-DWkvQuBM.js";
import { n as ChannelPlugin } from "../../types.public-i4hJTC6b.js";
//#region extensions/imessage/src/imessage.test-plugin.d.ts
declare const createIMessageTestPlugin: (params?: {
  outbound?: ChannelOutboundAdapter;
  actions?: ChannelMessageActionAdapter;
}) => ChannelPlugin;
//#endregion
export { createIMessageTestPlugin };