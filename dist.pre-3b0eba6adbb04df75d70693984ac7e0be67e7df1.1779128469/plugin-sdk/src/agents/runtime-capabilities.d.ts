import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function collectRuntimeChannelCapabilities(params: {
    cfg?: OpenClawConfig;
    channel?: string | null;
    accountId?: string | null;
}): string[] | undefined;
