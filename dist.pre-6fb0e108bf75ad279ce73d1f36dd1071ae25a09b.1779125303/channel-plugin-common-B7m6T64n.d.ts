import { n as ChatChannelId } from "./channel-id.types-D1ZJyHGT.js";
import { E as ChannelMeta } from "./types.core-DA-emjB6.js";
//#region src/channels/chat-meta-shared.d.ts
type ChatChannelMeta = ChannelMeta;
//#endregion
//#region src/channels/chat-meta.d.ts
declare function getChatChannelMeta(id: ChatChannelId): ChatChannelMeta;
//#endregion
export { getChatChannelMeta as t };