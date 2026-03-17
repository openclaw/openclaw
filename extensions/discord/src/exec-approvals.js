import { getExecApprovalReplyMetadata } from "../../../src/infra/exec-approval-reply.js";
import { resolveDiscordAccount } from "./accounts.js";
function isDiscordExecApprovalClientEnabled(params) {
  const config = resolveDiscordAccount(params).config.execApprovals;
  return Boolean(config?.enabled && (config.approvers?.length ?? 0) > 0);
}
function shouldSuppressLocalDiscordExecApprovalPrompt(params) {
  return isDiscordExecApprovalClientEnabled(params) && getExecApprovalReplyMetadata(params.payload) !== null;
}
export {
  isDiscordExecApprovalClientEnabled,
  shouldSuppressLocalDiscordExecApprovalPrompt
};
