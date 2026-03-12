export declare function normalizeDiscordMessagingTarget(raw: string): string | undefined;
/**
 * Normalize a Discord outbound target for delivery. Bare numeric IDs are
 * prefixed with "channel:" to avoid the ambiguous-target error in
 * parseDiscordTarget. All other formats pass through unchanged.
 */
export declare function normalizeDiscordOutboundTarget(to?: string): {
    ok: true;
    to: string;
} | {
    ok: false;
    error: Error;
};
export declare function looksLikeDiscordTargetId(raw: string): boolean;
