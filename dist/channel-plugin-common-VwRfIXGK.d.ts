import { n as ChatChannelId } from "./channel-id.types-ClK6B_QE.js";
import { E as ChannelMeta } from "./types.core-BkmTlRzr.js";
//#region src/channels/chat-meta-shared.d.ts
type ChatChannelMeta = ChannelMeta;
//#endregion
//#region src/channels/chat-meta.d.ts
declare function getChatChannelMeta(id: ChatChannelId): ChatChannelMeta;
//#endregion
export { getChatChannelMeta as t };