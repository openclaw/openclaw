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
  /**
   * PR-9 Wave B1 — closure-gate fields. Optional; when present, the
   * channel renderer surfaces acceptance criteria as a nested checklist
   * under each step (verified vs not). Backwards-compatible: omit both
   * fields and rendering is unchanged.
   */
  acceptanceCriteria?: string[];
  verifiedCriteria?: string[];
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
    const stepLine = renderStepLine(s.status, label, format);
    const criteriaLines = renderAcceptanceCriteria(s, format);
    return criteriaLines.length > 0 ? [stepLine, ...criteriaLines].join("\n") : stepLine;
  });

  return lines.join("\n");
}

function renderStepLine(
  status: PlanStepForRender["status"],
  label: string,
  format: PlanRenderFormat,
): string {
  switch (format) {
    case "html": {
      const esc = escapeHtml(label);
      if (status === "completed") {
        return `✅ ${esc}`;
      }
      if (status === "in_progress") {
        return `⏳ <b>${esc}</b>`;
      }
      if (status === "cancelled") {
        return `❌ <s>${esc}</s>`;
      }
      return `⬚ ${esc}`;
    }
    case "markdown": {
      const md = escapeMarkdown(label);
      if (status === "completed") {
        return `- [x] ${md}`;
      }
      if (status === "in_progress") {
        return `- [>] **${md}**`;
      }
      if (status === "cancelled") {
        return `- [~] ~~${md}~~`;
      }
      return `- [ ] ${md}`;
    }
    case "plaintext": {
      const safe = neutralizeMentions(label);
      const markers: Record<PlanStepForRender["status"], string> = {
        completed: "[x]",
        in_progress: "[>]",
        cancelled: "[~]",
        pending: "[ ]",
      };
      if (!Object.hasOwn(markers, status)) {
        warnUnknownStatus(status);
      }
      return `${markers[status] ?? "[ ]"} ${safe}`;
    }
    case "slack-mrkdwn": {
      const escaped = escapeSlackMrkdwn(label);
      if (status === "completed") {
        return `✅ ${escaped}`;
      }
      if (status === "in_progress") {
        return `⏳ *${escaped}*`;
      }
      if (status === "cancelled") {
        return `❌ ~${escaped}~`;
      }
      return `⬚ ${escaped}`;
    }
    default: {
      const _exhaustive: never = format;
      return `[ ] ${label}`;
    }
  }
}

/**
 * PR-9 Wave B1: render a step's acceptance criteria as a nested
 * checklist beneath the step line. Indentation + marker style matches
 * the parent format's conventions. Returns `[]` (no lines) when no
 * criteria are declared so existing simple plans render unchanged.
 *
 * Each criterion uses the same content sanitization as the parent
 * step label so injection vectors are equivalent across both layers.
 */
function renderAcceptanceCriteria(step: PlanStepForRender, format: PlanRenderFormat): string[] {
  const criteria = step.acceptanceCriteria;
  if (!criteria || criteria.length === 0) {
    return [];
  }
  const verified = new Set(step.verifiedCriteria ?? []);
  return criteria.map((rawCriterion) => {
    const criterion = rawCriterion.replace(/[\n\r]+/g, " ").trim();
    const isVerified = verified.has(rawCriterion);
    switch (format) {
      case "html": {
        const esc = escapeHtml(criterion);
        return isVerified ? `   ✓ ${esc}` : `   ◻ ${esc}`;
      }
      case "markdown": {
        const md = escapeMarkdown(criterion);
        return isVerified ? `    - [x] ${md}` : `    - [ ] ${md}`;
      }
      case "plaintext": {
        const safe = neutralizeMentions(criterion);
        return isVerified ? `   [x] ${safe}` : `   [ ] ${safe}`;
      }
      case "slack-mrkdwn": {
        const escaped = escapeSlackMrkdwn(criterion);
        return isVerified ? `   ✓ ${escaped}` : `   ◻ ${escaped}`;
      }
      default: {
        return `   [ ] ${criterion}`;
      }
    }
  });
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
      // Codex P2 #67534 r3095517064: neutralize @mentions in the title
      // path too — checklist labels are already protected by
      // neutralizeMentions() above, but a model-derived title like
      // `@everyone release plan` would still trigger mentions on
      // platforms that follow plaintext mention conventions.
      return `${neutralizeMentions(safeTitle)}\n${checklist}`;
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
  console.warn(
    `[plan-render] Unknown plan step status "${status}", falling back to pending rendering.`,
  );
}
