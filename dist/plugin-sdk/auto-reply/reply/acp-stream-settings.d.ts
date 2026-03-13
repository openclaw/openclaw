import type { AcpSessionUpdateTag } from "../../acp/runtime/types.js";
import type { OpenClawConfig } from "../../config/config.js";
export declare const ACP_TAG_VISIBILITY_DEFAULTS: Record<AcpSessionUpdateTag, boolean>;
export type AcpDeliveryMode = "live" | "final_only";
export type AcpHiddenBoundarySeparator = "none" | "space" | "newline" | "paragraph";
export type AcpProjectionSettings = {
    deliveryMode: AcpDeliveryMode;
    hiddenBoundarySeparator: AcpHiddenBoundarySeparator;
    repeatSuppression: boolean;
    maxOutputChars: number;
    maxSessionUpdateChars: number;
    tagVisibility: Partial<Record<AcpSessionUpdateTag, boolean>>;
};
export declare function resolveAcpProjectionSettings(cfg: OpenClawConfig): AcpProjectionSettings;
export declare function resolveAcpStreamingConfig(params: {
    cfg: OpenClawConfig;
    provider?: string;
    accountId?: string;
    deliveryMode?: AcpDeliveryMode;
}): {
    chunking: import("./block-streaming.js").BlockStreamingChunking;
    coalescing: import("./block-streaming.js").BlockStreamingCoalescing;
};
export declare function isAcpTagVisible(settings: AcpProjectionSettings, tag: AcpSessionUpdateTag | undefined): boolean;
