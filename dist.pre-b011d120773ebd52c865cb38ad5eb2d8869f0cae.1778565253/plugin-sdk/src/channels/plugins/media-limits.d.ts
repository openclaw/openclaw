import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function resolveChannelMediaMaxBytes(params: {
    cfg: OpenClawConfig;
    resolveChannelLimitMb: (params: {
        cfg: OpenClawConfig;
        accountId: string;
    }) => number | undefined;
    accountId?: string | null;
}): number | undefined;
