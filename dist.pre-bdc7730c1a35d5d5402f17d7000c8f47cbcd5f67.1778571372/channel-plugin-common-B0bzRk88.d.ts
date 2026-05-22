import { n as ChatChannelId } from "./channel-id.types-DU-7hQII.js";
import { E as ChannelMeta } from "./types.core-D5GEzFhB.js";
//#region src/channels/chat-meta-shared.d.ts
type ChatChannelMeta = ChannelMeta;
//#endregion
//#region src/channels/chat-meta.d.ts
declare function getChatChannelMeta(id: ChatChannelId): ChatChannelMeta;
//#endregion
export { getChatChannelMeta as t };