import type { DiscordMessageEvent } from "./message-handler.preflight.types.js";
export declare function resolveDiscordPreflightPluralKitInfo(params: {
    message: DiscordMessageEvent["message"];
    config?: NonNullable<NonNullable<import("openclaw/plugin-sdk/config-contracts").OpenClawConfig["channels"]>["discord"]>["pluralkit"];
    abortSignal?: AbortSignal;
}): Promise<Awaited<ReturnType<typeof import("../pluralkit.js").fetchPluralKitMessageInfo>>>;
