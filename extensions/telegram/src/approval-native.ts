import { createApproverRestrictedNativeApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { listTelegramAccountIds } from "./accounts.js";
import {
  getTelegramExecApprovalApprovers,
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalAuthorizedSender,
  isTelegramExecApprovalClientEnabled,
  isTelegramExecApprovalTargetRecipient,
  resolveTelegramExecApprovalTarget,
  shouldHandleTelegramExecApprovalRequest,
} from "./exec-approvals.js";
import { parseTelegramThreadId } from "./outbound-params.js";
import { normalizeTelegramChatId, parseTelegramTarget } from "./targets.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;
type TelegramOriginTarget = { to: string; threadId?: number };

function resolveTurnSourceTelegramOriginTarget(
  request: ApprovalRequest,
): TelegramOriginTarget | null {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  const rawTurnSourceTo = normalizeOptionalString(request.request.turnSourceTo) ?? "";
  const parsedTurnSourceTarget = rawTurnSourceTo ? parseTelegramTarget(rawTurnSourceTo) : null;
  const turnSourceTo = normalizeTelegramChatId(parsedTurnSourceTarget?.chatId ?? rawTurnSourceTo);
  if (turnSourceChannel !== "telegram" || !turnSourceTo) {
    return null;
  }
  const rawThreadId =
    request.request.turnSourceThreadId ?? parsedTurnSourceTarget?.messageThreadId ?? undefined;
  const directMessagesTopicId = parsedTurnSourceTarget?.directMessagesTopicId;
  return {
    to:
      directMessagesTopicId == null
        ? turnSourceTo
        : `${turnSourceTo}:direct-topic:${directMessagesTopicId}`,
    threadId: directMessagesTopicId == null ? parseTelegramThreadId(rawThreadId) : undefined,
  };
}

const resolveTelegramOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "telegram",
  shouldHandleRequest: shouldHandleTelegramExecApprovalRequest,
  resolveTurnSourceTarget: resolveTurnSourceTelegramOriginTarget,
  resolveSessionTarget: (sessionTarget) => ({
    to: normalizeTelegramChatId(sessionTarget.to) ?? sessionTarget.to,
    threadId: parseTelegramThreadId(sessionTarget.threadId),
  }),
});

const resolveTelegramApproverDmTargets = createChannelApproverDmTargetResolver({
  shouldHandleRequest: shouldHandleTelegramExecApprovalRequest,
  resolveApprovers: getTelegramExecApprovalApprovers,
  mapApprover: (approver) => ({ to: approver }),
});

function describeTelegramApprovalSetup(
  { accountId }: { accountId?: string | null },
  approvalKind: "exec" | "plugin",
) {
  const prefix =
    accountId && accountId !== "default"
      ? `channels.telegram.accounts.${accountId}`
      : "channels.telegram";
  const surface = approvalKind === "plugin" ? "Web UI or terminal UI" : "Web UI";
  return `Approve it from the ${surface} for now. Telegram supports native ${approvalKind} approvals for this account. Configure \`${prefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\`; leave \`${prefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
}

export const telegramApprovalCapability: ChannelApprovalCapability = {
  ...createApproverRestrictedNativeApprovalCapability({
    channel: "telegram",
    channelLabel: "Telegram",
    describeExecApprovalSetup: (params) => describeTelegramApprovalSetup(params, "exec"),
    describePluginApprovalSetup: (params) => describeTelegramApprovalSetup(params, "plugin"),
    listAccountIds: listTelegramAccountIds,
    hasApprovers: ({ cfg, accountId }) =>
      getTelegramExecApprovalApprovers({ cfg, accountId }).length > 0,
    isExecAuthorizedSender: isTelegramExecApprovalAuthorizedSender,
    isPluginAuthorizedSender: isTelegramExecApprovalApprover,
    isNativeDeliveryEnabled: isTelegramExecApprovalClientEnabled,
    resolveNativeDeliveryMode: resolveTelegramExecApprovalTarget,
    requireMatchingTurnSourceChannel: true,
    resolveSuppressionAccountId: ({ target, request }) =>
      normalizeOptionalString(target.accountId) ??
      normalizeOptionalString(request.request.turnSourceAccountId),
    resolveOriginTarget: resolveTelegramOriginTarget,
    resolveApproverDmTargets: resolveTelegramApproverDmTargets,
    notifyOriginWhenDmOnly: true,
    nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
      capabilityBoundary: true,
      eventKinds: ["exec", "plugin", "system-agent"],
      isConfigured: isTelegramExecApprovalClientEnabled,
      shouldHandle: shouldHandleTelegramExecApprovalRequest,
      load: async () =>
        (await import("./approval-handler.runtime.js")).telegramApprovalNativeRuntime,
    }),
  }),
  resolveApproveCommandBehavior: (params) => {
    if (
      params.approvalKind !== "exec" ||
      isTelegramExecApprovalClientEnabled(params) ||
      isTelegramExecApprovalTargetRecipient(params) ||
      (isTelegramExecApprovalAuthorizedSender(params) && !isTelegramExecApprovalApprover(params))
    ) {
      return undefined;
    }
    return {
      kind: "reply",
      text: "❌ Telegram exec approvals are not enabled for this bot account.",
    };
  },
};
