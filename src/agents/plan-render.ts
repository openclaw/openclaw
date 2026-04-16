/**
 * Plan checklist renderer for the GPT-5 parity sprint.
 *
 * Takes structured plan step data (from `AgentPlanEventData`) and renders
 * it as a native checklist for each delivery surface. Channel adapters
 * call {@link renderPlanChecklist} with the appropriate format.
 */

export type PlanRenderFormat = "html" | "markdown" | "plaintext" | "slack-mrkdwn";

export interface PlanStepForRender {
  step: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  activeForm?: string;
}

/**
 * Renders an array of plan steps into a formatted checklist string.
 *
 * - `html`: Telegram HTML parse mode (`<b>`, `<s>`, emoji markers)
 * - `markdown`: GitHub-flavored markdown checkboxes
 * - `plaintext`: ASCII markers for iMessage / BlueBubbles / SMS
 * - `slack-mrkdwn`: Slack's mrkdwn format (`*bold*`, `~strike~`)
 */
export function renderPlanChecklist(
  steps: PlanStepForRender[],
  format: PlanRenderFormat,
): string {
  if (steps.length === 0) {
    return "";
  }

  const lines = steps.map((s) => {
    const rawLabel =
      s.status === "in_progress" && s.activeForm ? s.activeForm : s.step;
    // Strip newlines from model-generated step text to prevent broken checklists.
    const label = rawLabel.replace(/[\n\r]+/g, " ").trim();

    switch (format) {
      case "html": {
        const esc = escapeHtml(label);
        if (s.status === "completed") { return `✅ ${esc}`; }
        if (s.status === "in_progress") { return `⏳ <b>${esc}</b>`; }
        if (s.status === "cancelled") { return `❌ <s>${esc}</s>`; }
        return `⬚ ${esc}`;
      }

      case "markdown": {
        if (s.status === "completed") { return `- [x] ${label}`; }
        if (s.status === "in_progress") { return `- [>] **${label}**`; }
        if (s.status === "cancelled") { return `- [~] ~~${label}~~`; }
        return `- [ ] ${label}`;
      }

      case "plaintext": {
        const markers: Record<string, string> = {
          completed: "[x]",
          in_progress: "[>]",
          cancelled: "[~]",
          pending: "[ ]",
        };
        return `${markers[s.status] ?? "[ ]"} ${label}`;
      }

      case "slack-mrkdwn": {
        const escaped = escapeSlackMrkdwn(label);
        if (s.status === "completed") { return `✅ ${escaped}`; }
        if (s.status === "in_progress") { return `⏳ *${escaped}*`; }
        if (s.status === "cancelled") { return `❌ ~${escaped}~`; }
        return `⬚ ${escaped}`;
      }

      default: {
        const _exhaustive: never = format;
        return `[ ] ${label}`;
      }
    }
  });

  return lines.join("\n");
}

/**
 * Renders a plan checklist with a header line.
 */
export function renderPlanWithHeader(
  title: string,
  steps: PlanStepForRender[],
  format: PlanRenderFormat,
): string {
  const checklist = renderPlanChecklist(steps, format);
  if (!checklist) {
    return "";
  }

  switch (format) {
    case "html":
      return `<b>${escapeHtml(title)}</b>\n${checklist}`;
    case "markdown":
      return `### ${title}\n${checklist}`;
    case "plaintext":
      return `${title}\n${checklist}`;
    case "slack-mrkdwn":
      return `*${escapeSlackMrkdwn(title)}*\n${checklist}`;
    default: {
      const _exhaustive: never = format;
      return `${title}\n${checklist}`;
    }
  }
}

/** Escapes Slack mrkdwn control characters: *, ~, `, _, and angle brackets. */
function escapeSlackMrkdwn(text: string): string {
  // Replace angle-bracket tokens first, then mrkdwn formatting chars.
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*/g, "\u2217") // ∗ (asterisk operator, visually similar)
    .replace(/~/g, "\u223C") // ∼ (tilde operator)
    .replace(/`/g, "\u2018") // ' (left single quote)
    .replace(/_/g, "\uFF3F") // ＿ (fullwidth low line, prevents italic parse)
    .replace(/@/g, "\uFE6B"); // ﹫ (small form variant, prevents mention parsing)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
