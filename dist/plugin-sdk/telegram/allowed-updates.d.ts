import { API_CONSTANTS } from "grammy";
type TelegramUpdateType = (typeof API_CONSTANTS.ALL_UPDATE_TYPES)[number];
export declare function resolveTelegramAllowedUpdates(): ReadonlyArray<TelegramUpdateType>;
export {};
