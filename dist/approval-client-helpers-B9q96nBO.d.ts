import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { Yt as ExecApprovalForwardTarget } from "./types.channels-C67UBRPK.js";
import { s as ExecApprovalRequest } from "./exec-approvals-DZ3KhICc.js";
import { r as ReplyPayload } from "./reply-payload-BlNiejVc.js";
import { o as PluginApprovalRequest } from "./plugin-approvals-BKi4KQTi.js";
//#region src/infra/approval-request-filters.d.ts
type ApprovalRequestFilterInput = {
  agentId?: string | null;
  sessionKey?: string | null;
};
declare function matchesApprovalRequestSessionFilter(sessionKey: string, patterns: string[]): boolean;
declare function matchesApprovalRequestFilters(params: {
  request: ApprovalRequestFilterInput;
  agentFilter?: string[];
  sessionFilter?: string[];
  fallbackAgentIdFromSessionKey?: boolean;
}): boolean;
//#endregion
//#region src/plugin-sdk/approval-client-helpers.d.ts
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
declare function isChannelExecApprovalClientEnabledFromConfig(params: {
  enabled?: ChannelExecApprovalEnableMode;
  approverCount: number;
}): boolean;
declare function isChannelExecApprovalTargetRecipient(params: {
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
declare function createChannelExecApprovalProfile(params: {
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
//#endregion
export { matchesApprovalRequestFilters as a, ApprovalRequestFilterInput as i, isChannelExecApprovalClientEnabledFromConfig as n, matchesApprovalRequestSessionFilter as o, isChannelExecApprovalTargetRecipient as r, createChannelExecApprovalProfile as t };