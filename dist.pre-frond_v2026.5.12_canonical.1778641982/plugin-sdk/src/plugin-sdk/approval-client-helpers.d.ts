import type { ExecApprovalForwardTarget } from "../config/types.approvals.js";
import { matchesApprovalRequestFilters } from "../infra/approval-request-filters.js";
import { getExecApprovalReplyMetadata } from "../infra/exec-approval-reply.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import type { OpenClawConfig } from "./config-runtime.js";
import type { ReplyPayload } from "./reply-payload.js";
type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalTarget = "dm" | "channel" | "both";
type ChannelExecApprovalEnableMode = boolean | "auto";
type ChannelApprovalConfig = {
    enabled?: ChannelExecApprovalEnableMode;
    target?: ApprovalTarget;
    agentFilter?: string[];
    sessionFilter?: string[];
};
type ApprovalProfileParams = {
    cfg: OpenClawConfig;
    accountId?: string | null;
};
export { getExecApprovalReplyMetadata, matchesApprovalRequestFilters };
export declare function isChannelExecApprovalClientEnabledFromConfig(params: {
    enabled?: ChannelExecApprovalEnableMode;
    approverCount: number;
}): boolean;
export declare function isChannelExecApprovalTargetRecipient(params: {
    cfg: OpenClawConfig;
    senderId?: string | null;
    accountId?: string | null;
    channel: string;
    normalizeSenderId?: (value: string) => string | undefined;
    matchTarget: (params: {
        target: ExecApprovalForwardTarget;
        normalizedSenderId: string;
        normalizedAccountId?: string;
    }) => boolean;
}): boolean;
export declare function createChannelExecApprovalProfile(params: {
    resolveConfig: (params: ApprovalProfileParams) => ChannelApprovalConfig | undefined;
    resolveApprovers: (params: ApprovalProfileParams) => string[];
    normalizeSenderId?: (value: string) => string | undefined;
    isTargetRecipient?: (params: ApprovalProfileParams & {
        senderId?: string | null;
    }) => boolean;
    matchesRequestAccount?: (params: ApprovalProfileParams & {
        request: ApprovalRequest;
    }) => boolean;
    fallbackAgentIdFromSessionKey?: boolean;
    requireClientEnabledForLocalPromptSuppression?: boolean;
}): {
    isClientEnabled: (input: ApprovalProfileParams) => boolean;
    isApprover: (input: ApprovalProfileParams & {
        senderId?: string | null;
    }) => boolean;
    isAuthorizedSender: (input: ApprovalProfileParams & {
        senderId?: string | null;
    }) => boolean;
    resolveTarget: (input: ApprovalProfileParams) => ApprovalTarget;
    shouldHandleRequest: (input: ApprovalProfileParams & {
        request: ApprovalRequest;
    }) => boolean;
    shouldSuppressLocalPrompt: (input: ApprovalProfileParams & {
        payload: ReplyPayload;
    }) => boolean;
};
