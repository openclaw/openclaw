import { getExecApprovalReplyMetadata } from "../../../src/infra/exec-approval-reply.js";
import { resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramTargetChatType } from "./targets.js";
function normalizeApproverId(value) {
  return String(value).trim();
}
function resolveTelegramExecApprovalConfig(params) {
  return resolveTelegramAccount(params).config.execApprovals;
}
function getTelegramExecApprovalApprovers(params) {
  return (resolveTelegramExecApprovalConfig(params)?.approvers ?? []).map(normalizeApproverId).filter(Boolean);
}
function isTelegramExecApprovalClientEnabled(params) {
  const config = resolveTelegramExecApprovalConfig(params);
  return Boolean(config?.enabled && getTelegramExecApprovalApprovers(params).length > 0);
}
function isTelegramExecApprovalApprover(params) {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return false;
  }
  const approvers = getTelegramExecApprovalApprovers(params);
  return approvers.includes(senderId);
}
function resolveTelegramExecApprovalTarget(params) {
  return resolveTelegramExecApprovalConfig(params)?.target ?? "dm";
}
function shouldInjectTelegramExecApprovalButtons(params) {
  if (!isTelegramExecApprovalClientEnabled(params)) {
    return false;
  }
  const target = resolveTelegramExecApprovalTarget(params);
  const chatType = resolveTelegramTargetChatType(params.to);
  if (chatType === "direct") {
    return target === "dm" || target === "both";
  }
  if (chatType === "group") {
    return target === "channel" || target === "both";
  }
  return target === "both";
}
function resolveExecApprovalButtonsExplicitlyDisabled(params) {
  const capabilities = resolveTelegramAccount(params).config.capabilities;
  if (!capabilities || Array.isArray(capabilities) || typeof capabilities !== "object") {
    return false;
  }
  const inlineButtons = capabilities.inlineButtons;
  return typeof inlineButtons === "string" && inlineButtons.trim().toLowerCase() === "off";
}
function shouldEnableTelegramExecApprovalButtons(params) {
  if (!shouldInjectTelegramExecApprovalButtons(params)) {
    return false;
  }
  return !resolveExecApprovalButtonsExplicitlyDisabled(params);
}
function shouldSuppressLocalTelegramExecApprovalPrompt(params) {
  void params.cfg;
  void params.accountId;
  return getExecApprovalReplyMetadata(params.payload) !== null;
}
export {
  getTelegramExecApprovalApprovers,
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalClientEnabled,
  resolveTelegramExecApprovalConfig,
  resolveTelegramExecApprovalTarget,
  shouldEnableTelegramExecApprovalButtons,
  shouldInjectTelegramExecApprovalButtons,
  shouldSuppressLocalTelegramExecApprovalPrompt
};
