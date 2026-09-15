// Line plugin module owns the Flex card for native approval prompts.
import type {
  ApprovalMetadataView,
  ChannelApprovalKind,
  PendingApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { formatExecApprovalExpiresIn } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { ExecApprovalDecision } from "openclaw/plugin-sdk/approval-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { buildLineApprovalPostbackData } from "./approval-postback.js";
import { createActionCard } from "./flex-templates/basic-cards.js";
import { fitsLineFlexBubble } from "./flex-templates/message.js";
import type { CardAction, FlexBubble } from "./flex-templates/types.js";

/** Native approval prompt prepared for one LINE conversation. */
export type LinePendingApprovalCard = {
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  expiresAtMs: number;
  altText: string;
  bubble: FlexBubble;
  /** True when the card body had to be shortened to fit the bubble ceiling. */
  bodyShortened: boolean;
  allowedDecisions: readonly ExecApprovalDecision[];
};

// Native delivery suppresses the local `/approve` prompt, and an approver reached only as an
// approver gets no forwarded text, so this card can be the only prompt they get and it has
// to fit. Losing the whole prompt is a silent failure; a shortened body that says it was
// shortened is a visible one.
const BODY_SHORTENED_MARKER = "[shortened to fit LINE's card limit]";

/**
 * Longest body the bubble can carry, measured against its real serialized size.
 *
 * `commandText` arrives bounded by `sanitizeExecApprovalDisplayText`, but the rationale,
 * its analysis lines, the metadata values, and the plugin/system-agent subject are
 * passed through raw, so the whole body is one shrinkable region rather than any single
 * field. The retained tail keeps the approval id reachable. The floor fits for any
 * ordinary id, since labels are capped at the Flex ceiling and action data at
 * `LINE_ACTION_DATA_LIMIT`; an id too long for the bubble leaves it oversized, and the
 * rejected send falls back to the approval command text.
 */
function fitApprovalCardBody(
  buildBubble: (body: string) => FlexBubble,
  body: string,
  identityLine: string,
): { bubble: FlexBubble; bodyShortened: boolean } {
  const full = buildBubble(body);
  if (fitsLineFlexBubble(full)) {
    return { bubble: full, bodyShortened: false };
  }
  const tail = `\n${BODY_SHORTENED_MARKER}\n${identityLine}`;
  let low = 0;
  let high = body.length;
  let best = buildBubble(tail.trimStart());
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const kept = truncateUtf16Safe(body, mid);
    // The id leads the metadata, so a long metadata value can keep it in the body.
    const candidate = buildBubble(
      kept.includes(identityLine) ? `${kept}\n${BODY_SHORTENED_MARKER}` : `${kept}${tail}`,
    );
    if (fitsLineFlexBubble(candidate)) {
      best = candidate;
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { bubble: best, bodyShortened: true };
}

function resolveApprovalKindLabel(approvalKind: ChannelApprovalKind): string {
  return approvalKind === "plugin"
    ? "Plugin"
    : approvalKind === "system-agent"
      ? "OpenClaw Change"
      : "Exec";
}

/** The one line that names what is being approved. */
function resolveApprovalSubjectSummary(view: PendingApprovalView): string {
  return view.approvalKind === "system-agent"
    ? view.operationSummary
    : view.approvalKind === "plugin"
      ? view.title
      : view.commandText;
}

// Flex text is plain, so the shared markdown prompt cannot be reused here. Section
// headers match the Adaptive Card sibling so one approval reads the same on both.
function buildApprovalSubjectText(view: PendingApprovalView): string {
  const summary = resolveApprovalSubjectSummary(view);
  if (view.approvalKind === "system-agent") {
    return `Change\n${summary}`;
  }
  if (view.approvalKind === "plugin") {
    return view.description ? `Request\n${summary}\n${view.description}` : `Request\n${summary}`;
  }
  const sections = [`Command\n${summary}`];
  if (view.commandPreview && view.commandPreview !== summary) {
    sections.push(`Preview\n${view.commandPreview}`);
  }
  return sections.join("\n\n");
}

// The reason for the interruption decides the answer, so it stays on the card. The
// analysis bound is the shared prompt's own, not a LINE choice.
function buildApprovalRationaleText(view: PendingApprovalView): string | undefined {
  if (view.approvalKind !== "exec") {
    return undefined;
  }
  const sections: string[] = [];
  const warningText = view.warningText?.trim();
  if (warningText) {
    sections.push(warningText);
  }
  const warningLines = view.commandAnalysis?.warningLines
    ?.map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (warningLines?.length) {
    sections.push(["Command analysis", ...warningLines.map((line) => `- ${line}`)].join("\n"));
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function buildApprovalMetadataText(
  identityLine: string,
  metadata: readonly ApprovalMetadataView[],
): string {
  return [identityLine, ...metadata.map(({ label, value }) => `${label}: ${value}`)].join("\n");
}

/**
 * Every offered decision, or nothing. A card missing one of them would steer the
 * answer toward the decisions it could draw, so a decision this card cannot carry
 * sends the whole prompt to the text path that still lists all of them.
 */
function buildApprovalCardActions(
  view: PendingApprovalView,
  channelSecret: string,
): CardAction[] | null {
  const actions: CardAction[] = [];
  for (const entry of view.actions) {
    const action = entry.action;
    const data =
      action?.type === "approval"
        ? buildLineApprovalPostbackData(action, channelSecret)
        : undefined;
    if (!data) {
      return null;
    }
    // The raw action is normalized once by the card builder, which owns the Flex
    // label ceiling; `postbackAction` would pre-cut it to the tighter default.
    actions.push({
      label: entry.label,
      action: { type: "postback", label: entry.label, data, displayText: entry.label },
    });
  }
  return actions.length > 0 ? actions : null;
}

/** Build the native approval card, or nothing when its decisions are not drawable. */
export function buildLinePendingApprovalCard(params: {
  view: PendingApprovalView;
  nowMs: number;
  /** The sending account's channel secret, which tags each decision button. */
  channelSecret: string;
}): LinePendingApprovalCard | null {
  const { view, nowMs } = params;
  const actions = buildApprovalCardActions(view, params.channelSecret);
  if (!actions) {
    return null;
  }
  const title = `${resolveApprovalKindLabel(view.approvalKind)} Approval Required`;
  const expiresIn = `Expires in: ${formatExecApprovalExpiresIn(view.expiresAtMs, nowMs)}`;
  const leading = [expiresIn, buildApprovalRationaleText(view)].filter(
    (section): section is string => Boolean(section),
  );
  const identityLine = `Approval ID: ${view.approvalId}`;
  const body = [
    ...leading,
    buildApprovalSubjectText(view),
    buildApprovalMetadataText(identityLine, view.metadata),
  ].join("\n\n");
  return {
    approvalId: view.approvalId,
    approvalKind: view.approvalKind,
    expiresAtMs: view.expiresAtMs,
    altText: `${title}: ${resolveApprovalSubjectSummary(view)}`,
    allowedDecisions: view.actions.map(({ decision }) => decision),
    ...fitApprovalCardBody(
      (carried) => createActionCard(title, carried, actions),
      body,
      identityLine,
    ),
  };
}
