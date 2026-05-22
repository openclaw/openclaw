import { n as ChatChannelId } from "./channel-id.types-BK_x91Vq.js";
import { E as ChannelMeta } from "./types.core-remGx4m5.js";
//#region src/channels/chat-meta-shared.d.ts
type ChatChannelMeta = ChannelMeta;
//#endregion
//#region src/channels/chat-meta.d.ts
declare function getChatChannelMeta(id: ChatChannelId): ChatChannelMeta;
//#endregion
export { getChatChannelMeta as t };