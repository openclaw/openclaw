import { type OpenClawConfig } from "../config/config.js";
export type ExecApprovalInitiatingSurfaceState = {
    kind: "enabled";
    channel: string | undefined;
    channelLabel: string;
} | {
    kind: "disabled";
    channel: string;
    channelLabel: string;
} | {
    kind: "unsupported";
    channel: string;
    channelLabel: string;
};
export declare function resolveExecApprovalInitiatingSurfaceState(params: {
    channel?: string | null;
    accountId?: string | null;
    cfg?: OpenClawConfig;
}): ExecApprovalInitiatingSurfaceState;
export declare function hasConfiguredExecApprovalDmRoute(cfg: OpenClawConfig): boolean;
