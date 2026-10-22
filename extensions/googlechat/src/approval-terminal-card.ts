import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { formatApprovalDecisionLabel } from "openclaw/plugin-sdk/approval-runtime";
import {
  buildGoogleChatApprovalTextWidget as buildTextWidget,
  escapeGoogleChatApprovalCardText as escapeGoogleChatText,
} from "./approval-card-text.js";
import type { GoogleChatCardV2 } from "./types.js";

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

/** Render the canonical first-answer result without retaining any actionable buttons. */
export function buildGoogleChatCanonicalApprovalTerminalCards(
  result: ApprovalResolveResult,
): GoogleChatCardV2[] {
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
  return [
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
  ];
}
