export declare function normalizeDiscordMessagingTarget(raw: string): string | undefined;
/**
 * Normalize a Discord outbound target for delivery. Bare numeric IDs are
 * prefixed with "channel:" to avoid the ambiguous-target error in
 * parseDiscordTarget, unless the ID is explicitly configured as an allowed DM
 * sender. All other formats pass through unchanged.
 */
export declare function normalizeDiscordOutboundTarget(to?: string, allowFrom?: readonly string[]): {
    ok: true;
    to: string;
} | {
    ok: false;
    error: Error;
};
export declare function allowFromContainsDiscordUserId(allowFrom: readonly string[] | undefined, userId: string): boolean;
export declare function looksLikeDiscordTargetId(raw: string): boolean;
