import type { SlackMessageEvent } from "../../types.js";
export declare function buildTopLevelSlackConversationKey(message: SlackMessageEvent, accountId: string): string | null;
export declare function buildSlackDebounceKey(message: SlackMessageEvent, accountId: string): string | null;
