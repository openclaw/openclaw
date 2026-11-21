import {
  resolveApprovalOverGateway,
  type ApprovalResolveResult,
} from "openclaw/plugin-sdk/approval-gateway-runtime";
import { formatApprovalDecisionLabel } from "openclaw/plugin-sdk/approval-runtime";
import { updateGoogleChatMessage } from "./api.js";
import { googleChatApprovalAuth } from "./approval-auth.js";
import {
  googleChatApprovalControls,
  readGoogleChatApprovalActionToken,
} from "./approval-card-actions.js";
import {
  buildGoogleChatApprovalTextWidget as buildTextWidget,
  escapeGoogleChatApprovalCardText as escapeGoogleChatText,
} from "./approval-card-text.js";
import type { WebhookTarget } from "./monitor-types.js";
import type { GoogleChatCardV2, GoogleChatEvent } from "./types.js";

const GOOGLECHAT_APPROVAL_CARD_ID = "openclaw-approval";
function formatCanonicalOutcome(approval: ApprovalResolveResult["approval"]): string {
  if (approval.status === "allowed" || approval.status === "denied") {
    return formatApprovalDecisionLabel(approval.decision);
  }
  return approval.status === "expired"
    ? "Expired"
    : approval.status === "cancelled"
      ? "Cancelled"
      : "Unavailable";
}

function buildSubjectSection(
  presentation: ApprovalResolveResult["approval"]["presentation"],
): NonNullable<GoogleChatCardV2["card"]["sections"]>[number] {
  if (presentation.kind === "exec") {
    return {
      header: "Command",
      widgets: [buildTextWidget(presentation.commandPreview ?? presentation.commandText)],
    };
  }
  const description = presentation.description.trim();
  const requestText = `<b>${escapeGoogleChatText(presentation.title)}</b>${
    description ? `<br>${escapeGoogleChatText(description)}` : ""
  }`;
  return {
    header: "Request",
    widgets: [buildTextWidget(requestText, "html")],
  };
}

function logIgnored(target: WebhookTarget, message: string): void {
  target.runtime.log?.(`[${target.account.accountId}] googlechat approval ignored: ${message}`);
}

export async function maybeHandleGoogleChatApprovalCardClick(params: {
  event: GoogleChatEvent;
  target: WebhookTarget;
}): Promise<boolean> {
  const eventType = params.event.type ?? params.event.eventType;
  if (eventType !== "CARD_CLICKED") {
    return false;
  }
  const token = readGoogleChatApprovalActionToken(params.event);
  if (!token) {
    return false;
  }

  const binding = googleChatApprovalControls.get(token);
  if (!binding) {
    logIgnored(params.target, "unknown or expired card token");
    return true;
  }
  if (binding.accountId !== params.target.account.accountId) {
    logIgnored(params.target, "card token account mismatch");
    return true;
  }
  if (params.event.space?.name !== binding.spaceName) {
    logIgnored(params.target, "card token space mismatch");
    return true;
  }
  if (params.event.message?.name && params.event.message.name !== binding.messageName) {
    logIgnored(params.target, "card token message mismatch");
    return true;
  }
  if (!binding.allowedDecisions.includes(binding.decision)) {
    logIgnored(params.target, "card token decision is no longer allowed");
    return true;
  }

  const actor = params.event.user?.name;
  const auth = googleChatApprovalAuth.authorizeActorAction?.({
    cfg: params.target.config,
    accountId: params.target.account.accountId,
    senderId: actor,
    action: "approve",
    approvalKind: binding.approvalKind,
  });
  if (!auth?.authorized) {
    logIgnored(params.target, `unauthorized actor ${actor || "unknown"}`);
    return true;
  }

  const outcome = await googleChatApprovalControls.settle(token, async (consumed) => {
    const result = await resolveApprovalOverGateway({
      cfg: params.target.config,
      approvalId: consumed.approvalId,
      approvalKind: consumed.approvalKind,
      decision: consumed.decision,
      channel: "googlechat",
      accountId: params.target.account.accountId,
      senderId: actor,
    });
    // Render the canonical first-answer result without retaining any actionable buttons.
    const { approval } = result;
    const kindLabel = approval.presentation.kind === "plugin" ? "Plugin" : "Exec";
    const detailLines = [
      `<b>Approval ID:</b> ${escapeGoogleChatText(JSON.stringify(approval.id).slice(1, -1))}`,
      `<b>Status:</b> ${escapeGoogleChatText(approval.status)}`,
      ...(approval.status === "allowed" || approval.status === "denied"
        ? [`<b>Decision:</b> ${escapeGoogleChatText(approval.decision)}`]
        : []),
      `<b>Reason:</b> ${escapeGoogleChatText(approval.reason)}`,
    ];
    await updateGoogleChatMessage({
      account: params.target.account,
      messageName: consumed.messageName,
      cardsV2: [
        {
          cardId: GOOGLECHAT_APPROVAL_CARD_ID,
          card: {
            header: {
              title: `${kindLabel} Approval: ${formatCanonicalOutcome(approval)}`,
              subtitle: result.applied ? "Resolved by this action" : "Already resolved",
            },
            sections: [
              buildSubjectSection(approval.presentation),
              {
                header: "Details",
                widgets: [buildTextWidget(detailLines.join("<br>"), "html")],
              },
            ],
          },
        },
      ],
    });
    return result;
  });
  if (outcome.kind !== "settled") {
    logIgnored(
      params.target,
      outcome.kind === "missing"
        ? "card token already consumed"
        : outcome.kind === "in-flight"
          ? "card token resolve already in flight"
          : `approval expired or no longer exists id=${outcome.binding.approvalId}`,
    );
    return true;
  }
  const { binding: consumed, result } = outcome;
  const label = result.applied ? "resolved" : "already resolved";
  const decision = "decision" in result.approval ? result.approval.decision : "none";
  params.target.runtime.log?.(
    `[${params.target.account.accountId}] googlechat approval ${label} id=${consumed.approvalId} status=${result.approval.status} decision=${decision} sender=${actor || "unknown"}`,
  );
  return true;
}
