import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
export type MessageActionTargetMode = "to" | "channelId" | "none";
export declare const MESSAGE_ACTION_TARGET_MODE: Record<ChannelMessageActionName, MessageActionTargetMode>;
export declare function actionRequiresTarget(action: ChannelMessageActionName): boolean;
export declare function actionHasTarget(action: ChannelMessageActionName, params: Record<string, unknown>, options?: {
    channel?: string;
}): boolean;
