import {
  resolveExecApprovalCommandDisplay,
  type ExecApprovalRequest,
  type ExecApprovalResolved,
} from "openclaw/plugin-sdk/infra-runtime";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import { truncateSlackText } from "./truncate.js";

const SLACK_SECTION_TEXT_MAX = 3000;
// Reserve 6 chars for the triple-backtick wrapper (``` ... ```)
const SLACK_CODE_BLOCK_CONTENT_MAX = SLACK_SECTION_TEXT_MAX - 6;

const SLACK_EXEC_APPROVE_ACTION_ID = "openclaw:exec_approve";
const SLACK_EXEC_APPROVE_ALWAYS_ACTION_ID = "openclaw:exec_approve_always";
const SLACK_EXEC_APPROVE_DENY_ACTION_ID = "openclaw:exec_approve_deny";

export const SLACK_EXEC_APPROVE_ACTION_PREFIX = "openclaw:exec_approve";

/** Escape text for use inside a mrkdwn triple-backtick code block. */
function escapeCodeBlock(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("`", "\u02CB");
}

function decisionLabel(decision: string): string {
  switch (decision) {
    case "allow-once":
      return "Allowed (once)";
    case "allow-always":
      return "Always allowed";
    case "deny":
      return "Denied";
    default:
      return escapeSlackMrkdwn(decision);
  }
}

export function buildSlackExecApprovalPendingBlocks(
  request: ExecApprovalRequest,
  nowMs: number,
): unknown[] {
  const commandDisplay = resolveExecApprovalCommandDisplay(request.request).commandText;
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));

  const metaLines: string[] = [`*ID:* \`${escapeSlackMrkdwn(request.id)}\``];
  if (request.request.cwd) {
    metaLines.push(`*CWD:* ${escapeSlackMrkdwn(request.request.cwd)}`);
  }
  if (request.request.host) {
    metaLines.push(`*Host:* ${escapeSlackMrkdwn(request.request.host)}`);
  }
  if (request.request.agentId) {
    metaLines.push(`*Agent:* ${escapeSlackMrkdwn(request.request.agentId)}`);
  }
  if (request.request.security) {
    metaLines.push(`*Security:* ${escapeSlackMrkdwn(request.request.security)}`);
  }
  if (request.request.ask) {
    metaLines.push(`*Ask:* ${escapeSlackMrkdwn(request.request.ask)}`);
  }
  metaLines.push(`*Expires in:* ${expiresIn}s`);

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Exec approval required", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`\`\`${truncateSlackText(escapeCodeBlock(commandDisplay), SLACK_CODE_BLOCK_CONTENT_MAX)}\`\`\``,
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: metaLines.join("  |  ") }],
    },
    {
      type: "actions",
      block_id: `exec_approval_${request.id}`,
      elements: [
        {
          type: "button",
          action_id: SLACK_EXEC_APPROVE_ACTION_ID,
          text: { type: "plain_text", text: "Allow Once", emoji: true },
          value: `${request.id}:allow-once`,
          style: "primary",
        },
        {
          type: "button",
          action_id: SLACK_EXEC_APPROVE_ALWAYS_ACTION_ID,
          text: { type: "plain_text", text: "Always Allow", emoji: true },
          value: `${request.id}:allow-always`,
        },
        {
          type: "button",
          action_id: SLACK_EXEC_APPROVE_DENY_ACTION_ID,
          text: { type: "plain_text", text: "Deny", emoji: true },
          value: `${request.id}:deny`,
          style: "danger",
        },
      ],
    },
  ];
}

/**
 * Extract the command text from a pending approval message's blocks.
 * The pending message renders the command in a section block as ``` ```commandText``` ```.
 */
export function extractCommandFromPendingBlocks(blocks: unknown[] | undefined): string | undefined {
  if (!Array.isArray(blocks)) {
    return undefined;
  }
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typed = block as { type?: string; text?: { type?: string; text?: string } };
    if (typed.type === "section" && typed.text?.type === "mrkdwn") {
      const match = typed.text.text?.match(/^```([\s\S]*)```$/);
      if (match) {
        return match[1];
      }
    }
  }
  return undefined;
}

export function buildSlackExecApprovalResolvedBlocks(
  resolved: ExecApprovalResolved & { commandText?: string },
): unknown[] {
  const commandDisplay =
    resolved.commandText ??
    (resolved.request
      ? resolveExecApprovalCommandDisplay(resolved.request).commandText
      : "unknown");
  const decision = decisionLabel(resolved.decision);
  const byText = resolved.resolvedBy ? ` by ${escapeSlackMrkdwn(resolved.resolvedBy)}` : "";
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Exec approval resolved", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`\`\`${truncateSlackText(escapeCodeBlock(commandDisplay), SLACK_CODE_BLOCK_CONTENT_MAX)}\`\`\``,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*${decision}*${byText}. ID: \`${escapeSlackMrkdwn(resolved.id)}\``,
        },
      ],
    },
  ];
}

export function buildSlackExecApprovalPendingFallbackText(
  request: ExecApprovalRequest,
  nowMs: number,
): string {
  const commandDisplay = resolveExecApprovalCommandDisplay(request.request).commandText;
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));
  return `Exec approval required: \`${escapeSlackMrkdwn(commandDisplay)}\` (expires in ${expiresIn}s) [${escapeSlackMrkdwn(request.id)}]`;
}

export function buildSlackExecApprovalResolvedFallbackText(resolved: ExecApprovalResolved): string {
  const decision = decisionLabel(resolved.decision);
  const byText = resolved.resolvedBy ? ` by ${escapeSlackMrkdwn(resolved.resolvedBy)}` : "";
  return `Exec approval resolved: ${decision}${byText} [${escapeSlackMrkdwn(resolved.id)}]`;
}
