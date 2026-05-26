import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region src/plugin-sdk/approval-auth-helpers.d.ts
type ApprovalKind = "exec" | "plugin";
type ApprovalAuthorizationResult = {
  authorized: boolean;
  reason?: string;
};
declare function createResolvedApproverActionAuthAdapter(params: {
  channelLabel: string;
  resolveApprovers: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => string[];
  normalizeSenderId?: (value: string) => string | undefined;
}): {
  authorizeActorAction({
    cfg,
    accountId,
    senderId,
    approvalKind
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    senderId?: string | null;
    action: "approve";
    approvalKind: ApprovalKind;
  }): ApprovalAuthorizationResult | {
    readonly authorized: true;
    readonly reason?: undefined;
  } | {
    readonly authorized: false;
    readonly reason: `\u274C You are not authorized to approve exec requests on ${string}.` | `\u274C You are not authorized to approve plugin requests on ${string}.`;
  };
};
//#endregion
//#region src/plugin-sdk/approval-approvers.d.ts
type ApproverInput = string | number;
declare function resolveApprovalApprovers(params: {
  explicit?: readonly ApproverInput[] | null;
  allowFrom?: readonly ApproverInput[] | null;
  extraAllowFrom?: readonly ApproverInput[] | null;
  defaultTo?: string | null;
  normalizeApprover: (value: ApproverInput) => string | undefined;
  normalizeDefaultTo?: (value: string) => string | undefined;
}): string[];
//#endregion
export { createResolvedApproverActionAuthAdapter as n, resolveApprovalApprovers as t };