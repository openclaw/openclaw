import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export declare function normalizeSlackApproverId(value: string | number): string | undefined;
export declare function getSlackExecApprovalApprovers(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): string[];
export declare function isSlackExecApprovalTargetRecipient(params: {
    cfg: OpenClawConfig;
    senderId?: string | null;
    accountId?: string | null;
}): boolean;
export declare const isSlackExecApprovalClientEnabled: (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}) => boolean;
export declare const isSlackExecApprovalApprover: (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
} & {
    senderId?: string | null;
}) => boolean;
export declare const isSlackExecApprovalAuthorizedSender: (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
} & {
    senderId?: string | null;
}) => boolean;
export declare const resolveSlackExecApprovalTarget: (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}) => "both" | "channel" | "dm";
export declare const shouldHandleSlackExecApprovalRequest: (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
} & {
    request: import("openclaw/plugin-sdk/approval-runtime").ExecApprovalRequest | import("openclaw/plugin-sdk/approval-runtime").PluginApprovalRequest;
}) => boolean;
export declare const shouldSuppressLocalSlackExecApprovalPrompt: (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
} & {
    payload: import("openclaw/plugin-sdk").ReplyPayload;
}) => boolean;
