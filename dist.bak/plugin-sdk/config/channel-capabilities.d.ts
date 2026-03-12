import type { OpenClawConfig } from "./config.js";
export declare function resolveChannelCapabilities(params: {
    cfg?: Partial<OpenClawConfig>;
    channel?: string | null;
    accountId?: string | null;
}): string[] | undefined;
