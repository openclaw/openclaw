import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { DiscordExecApprovalConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
export declare function shouldHandleDiscordApprovalRequest(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    request: ApprovalRequest;
    configOverride?: DiscordExecApprovalConfig | null;
}): boolean;
export {};
