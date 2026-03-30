export type DiscordModerationAction = "timeout" | "kick" | "ban";
export type DiscordModerationCommand = {
    action: DiscordModerationAction;
    guildId: string;
    userId: string;
    durationMinutes?: number;
    until?: string;
    reason?: string;
    deleteMessageDays?: number;
};
export declare function isDiscordModerationAction(action: string): action is DiscordModerationAction;
export declare function requiredGuildPermissionForModerationAction(action: DiscordModerationAction): bigint;
export declare function readDiscordModerationCommand(action: string, params: Record<string, unknown>): DiscordModerationCommand;
