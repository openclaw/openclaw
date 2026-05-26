import { type ChatChannelId } from "./ids.js";
import type { ChannelMeta } from "./plugins/types.core.js";
export type ChatChannelMeta = ChannelMeta;
export declare function buildChatChannelMetaById(): Record<ChatChannelId, ChatChannelMeta>;
