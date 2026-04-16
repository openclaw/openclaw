/**
 * Plan checklist renderer for the GPT-5 parity sprint.
 *
 * Takes structured plan step data and renders it as a native checklist
 * for each delivery surface. Channel adapters call
 * {@link renderPlanChecklist} with the appropriate format.
 *
 * Step shape matches the `update_plan` tool output (step, status, activeForm).
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
export function renderPlanChecklist(steps: PlanStepForRender[], format: PlanRenderFormat): string {
  if (steps.length === 0) {
    return "";
  }

  const lines = steps.map((s) => {
    // Treat whitespace-only activeForm as missing — fall back to step text.
    const hasUsableActiveForm = typeof s.activeForm === "string" && s.activeForm.trim().length > 0;
    const rawLabel = s.status === "in_progress" && hasUsableActiveForm ? s.activeForm! : s.step;
    // Strip newlines from model-generated step text to prevent broken checklists.
    const label = rawLabel.replace(/[\n\r]+/g, " ").trim();

    switch (format) {
      case "html": {
        const esc = escapeHtml(label);
        if (s.status === "completed") {
          return `✅ ${esc}`;
        }
        if (s.status === "in_progress") {
          return `⏳ <b>${esc}</b>`;
        }
        if (s.status === "cancelled") {
          return `❌ <s>${esc}</s>`;
        }
        return `⬚ ${esc}`;
      }

      case "markdown": {
        // Escape user-controlled text to prevent markdown injection
        // (links, code spans, emphasis, headings).
        const md = escapeMarkdown(label);
        if (s.status === "completed") {
          return `- [x] ${md}`;
        }
        if (s.status === "in_progress") {
          return `- [>] **${md}**`;
        }
        if (s.status === "cancelled") {
          return `- [~] ~~${md}~~`;
        }
        return `- [ ] ${md}`;
      }

      case "plaintext": {
        // Neutralize @channel/@here/@everyone mention triggers even in
        // plaintext (some clients still parse them).
        const safe = neutralizeMentions(label);
        const markers: Record<PlanStepForRender["status"], string> = {
          completed: "[x]",
          in_progress: "[>]",
          cancelled: "[~]",
          pending: "[ ]",
        };
        if (!Object.hasOwn(markers, s.status)) {
          warnUnknownStatus(s.status);
        }
        return `${markers[s.status] ?? "[ ]"} ${safe}`;
      }

      case "slack-mrkdwn": {
        const escaped = escapeSlackMrkdwn(label);
        if (s.status === "completed") {
          return `✅ ${escaped}`;
        }
        if (s.status === "in_progress") {
          return `⏳ *${escaped}*`;
        }
        if (s.status === "cancelled") {
          return `❌ ~${escaped}~`;
        }
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
  // Strip newlines from title to prevent broken headings/formatting.
  const safeTitle = title.replace(/[\n\r]+/g, " ").trim();

  switch (format) {
    case "html":
      return `<b>${escapeHtml(safeTitle)}</b>\n${checklist}`;
    case "markdown":
      return `### ${safeTitle}\n${checklist}`;
    case "plaintext":
      return `${safeTitle}\n${checklist}`;
    case "slack-mrkdwn":
      return `*${escapeSlackMrkdwn(safeTitle)}*\n${checklist}`;
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
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escapes markdown meta-characters in user-controlled text so a step like
 * "Deploy `rm -rf /`" or "[click](evil)" doesn't render as a code span or link.
 */
function escapeMarkdown(text: string): string {
  // Order matters: backslash first so we don't re-escape our own escapes.
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, "\\$&");
}

/**
 * Inserts U+FE6B between '@' and known mention triggers to prevent
 * @channel / @here / @everyone notifications from user-controlled text.
 * Mirrors the slack-mrkdwn approach but applied across plaintext too.
 */
function neutralizeMentions(text: string): string {
  return text.replace(/@(channel|here|everyone)\b/gi, "@\uFE6B$1");
}

const warnedStatuses = new Set<string>();
function warnUnknownStatus(status: string): void {
  if (warnedStatuses.has(status)) {
    return;
  }
  warnedStatuses.add(status);
  // eslint-disable-next-line no-console
  console.warn(
    `[plan-render] Unknown plan step status "${status}", falling back to pending rendering.`,
  );
}
