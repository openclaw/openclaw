import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMSTeamsAccountConfig } from "./accounts.js";
import { msTeamsApprovalAuth } from "./approval-auth.js";
import {
  msTeamsApprovalControls,
  readMSTeamsApprovalActionToken,
} from "./approval-card-actions.js";
import { buildMSTeamsCanonicalApprovalTerminalCard } from "./approval-card.js";
import { normalizeMSTeamsConversationId } from "./inbound.js";
import { buildMSTeamsAdaptiveCardActivity } from "./message-activity.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

function isMSTeamsApprovalSubmit(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.openclawAction === "approval") {
    return true;
  }
  const action = isRecord(value.action) ? value.action : undefined;
  const data = action?.data;
  return isRecord(data) && data.openclawAction === "approval";
}

export async function maybeHandleMSTeamsApprovalCardSubmit(params: {
  context: MSTeamsTurnContext;
  deps: MSTeamsMessageHandlerDeps;
}): Promise<boolean> {
  const { context, deps } = params;
  if (!isMSTeamsApprovalSubmit(context.activity.value)) {
    return false;
  }

  const ignored = (reason: string) => deps.log.info("msteams approval ignored", { reason });
  const token = readMSTeamsApprovalActionToken(context.activity.value);
  if (!token) {
    ignored("missing card token");
    return true;
  }
  const binding = msTeamsApprovalControls.get(token);
  if (!binding) {
    ignored("unknown or expired card token");
    return true;
  }
  // A card is valid only on the bot instance that issued it. Without this
  // receiver check, another account's listener could resolve the approval.
  if (normalizeAccountId(binding.accountId) !== normalizeAccountId(deps.accountId)) {
    ignored("card token account mismatch");
    return true;
  }
  if (
    normalizeMSTeamsConversationId(context.activity.conversation?.id ?? "") !==
    normalizeMSTeamsConversationId(binding.conversationId)
  ) {
    ignored("card token conversation mismatch");
    return true;
  }
  if (context.activity.replyToId && context.activity.replyToId !== binding.activityId) {
    ignored("card token activity mismatch");
    return true;
  }
  if (!binding.allowedDecisions.includes(binding.decision)) {
    ignored("card token decision is no longer allowed");
    return true;
  }

  const cfg = deps.readConfig?.() ?? deps.cfg;
  const account = resolveMSTeamsAccountConfig(cfg, binding.accountId);
  if (account.appId && account.appId !== deps.appId) {
    ignored("issuing account is no longer active");
    return true;
  }
  const senderId = context.activity.from?.aadObjectId;
  const authorization = msTeamsApprovalAuth.authorizeActorAction?.({
    cfg,
    accountId: binding.accountId,
    senderId,
    action: "approve",
    approvalKind: binding.approvalKind,
  });
  if (!authorization?.authorized) {
    ignored(`unauthorized actor ${senderId || "unknown"}`);
    return true;
  }

  const outcome = await msTeamsApprovalControls.settle(token, async (consumed) => {
    const result = await resolveApprovalOverGateway({
      cfg,
      approvalId: consumed.approvalId,
      approvalKind: consumed.approvalKind,
      decision: consumed.decision,
      channel: "msteams",
      accountId: consumed.accountId,
      senderId,
    });
    await context.updateActivity({
      ...buildMSTeamsAdaptiveCardActivity(buildMSTeamsCanonicalApprovalTerminalCard(result)),
      id: consumed.activityId,
    });
    return result;
  });
  if (outcome.kind !== "settled") {
    ignored(
      outcome.kind === "missing"
        ? "card token already consumed"
        : outcome.kind === "in-flight"
          ? "card token resolve already in flight"
          : `approval expired or no longer exists id=${outcome.binding.approvalId}`,
    );
    return true;
  }

  const { binding: consumed, result } = outcome;
  deps.log.info("msteams approval resolved", {
    approvalId: consumed.approvalId,
    approvalKind: consumed.approvalKind,
    applied: result.applied,
    status: result.approval.status,
    senderId,
  });
  return true;
}
