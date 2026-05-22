import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export declare function resolveDiscordDraftStreamingChunking(cfg: OpenClawConfig, accountId?: string | null): {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
};
