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
      // PR-11 deep-dive review B1: neutralize mentions BEFORE escaping
      // so an agent-controlled step text like "@everyone deploy now"
      // can't ping a Telegram channel or any HTML-rendering surface
      // that follows mention conventions.
      const esc = escapeHtml(neutralizeMentions(label));
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
      // PR-11 deep-dive review B1 (BLOCKER): markdown renders on
      // Discord, Mattermost, Matrix, MSTeams, GoogleChat, Feishu, web,
      // CLI. Without neutralization, an agent-controlled step text
      // containing "@everyone" pings the entire channel on Discord +
      // Mattermost. escapeMarkdown handles `*`/`[`/etc but does NOT
      // touch `@`, so we need a separate pass.
      const md = escapeMarkdown(neutralizeMentions(label));
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
        // Same PR-11 B1 neutralization as the parent step path.
        const esc = escapeHtml(neutralizeMentions(criterion));
        return isVerified ? `   ✓ ${esc}` : `   ◻ ${esc}`;
      }
      case "markdown": {
        const md = escapeMarkdown(neutralizeMentions(criterion));
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
      return `<b>${escapeHtml(neutralizeMentions(safeTitle))}</b>\n${checklist}`;
    case "markdown":
      // PR-11 B1: same mention-neutralization pass as the markdown
      // step branch — `### @everyone Plan` pings the channel on
      // Discord/Mattermost without this.
      return `### ${escapeMarkdown(neutralizeMentions(safeTitle))}\n${checklist}`;
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

/**
 * PR-14: render the full plan archetype as a single markdown document
 * suitable for persistence to disk and delivery as a file attachment
 * (e.g., a Telegram document upload).
 *
 * Produces sections in canonical order:
 *   # <title>
 *   ## Summary
 *   ## Analysis
 *   ## Plan        (checklist via renderPlanChecklist markdown branch)
 *   ## Assumptions (bullet list)
 *   ## Risks       (bullet list with mitigation)
 *   ## Verification (bullet list)
 *   ## References  (bullet list)
 *
 * Each optional section is omitted when its field is absent or empty,
 * so a minimal plan (title + steps only) renders as just the H1 +
 * `## Plan` + checklist. All user-controlled text passes through
 * `escapeMarkdown` + `neutralizeMentions` to defeat injection vectors
 * (matching the PR-11 deep-dive review B1 fix).
 */
export interface PlanArchetypeMarkdownInput {
  title: string;
  summary?: string;
  analysis?: string;
  plan: PlanStepForRender[];
  assumptions?: string[];
  risks?: Array<{ risk: string; mitigation: string }>;
  verification?: string[];
  references?: string[];
  /** Optional ISO date footer; defaults to new Date().toISOString().slice(0,10). */
  generatedAt?: Date;
}

export function renderFullPlanArchetypeMarkdown(input: PlanArchetypeMarkdownInput): string {
  const lines: string[] = [];
  // Title is REQUIRED; render even if empty (downstream callers should
  // provide a fallback like "Untitled plan").
  const safeTitle = (input.title || "Untitled plan").replace(/[\n\r]+/g, " ").trim();
  lines.push(`# ${escapeMarkdown(neutralizeMentions(safeTitle))}`);

  if (input.summary && input.summary.trim()) {
    lines.push("", "## Summary", escapeMarkdown(neutralizeMentions(input.summary.trim())));
  }

  if (input.analysis && input.analysis.trim()) {
    // Analysis is multi-paragraph. Preserve paragraph breaks but
    // strip carriage returns + escape per-line. Newlines in markdown
    // ARE meaningful, so we preserve `\n\n` as paragraph separators.
    const analysisBody = input.analysis
      .replace(/\r/g, "")
      .split("\n\n")
      .map((para) => escapeMarkdown(neutralizeMentions(para.trim())))
      .filter((para) => para.length > 0)
      .join("\n\n");
    if (analysisBody.length > 0) {
      lines.push("", "## Analysis", analysisBody);
    }
  }

  // Plan section is REQUIRED — but if the steps array is empty, emit
  // a placeholder note rather than an empty section header.
  lines.push("", "## Plan");
  if (input.plan && input.plan.length > 0) {
    lines.push(renderPlanChecklist(input.plan, "markdown"));
  } else {
    lines.push("_No plan steps provided._");
  }

  if (input.assumptions && input.assumptions.length > 0) {
    const items = input.assumptions
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => `- ${escapeMarkdown(neutralizeMentions(entry))}`);
    if (items.length > 0) {
      lines.push("", "## Assumptions", items.join("\n"));
    }
  }

  if (input.risks && input.risks.length > 0) {
    const items = input.risks
      .filter((entry) => entry?.risk?.trim() && entry?.mitigation?.trim())
      .map((entry) => {
        const r = escapeMarkdown(neutralizeMentions(entry.risk.trim()));
        const m = escapeMarkdown(neutralizeMentions(entry.mitigation.trim()));
        return `- **${r}**: ${m}`;
      });
    if (items.length > 0) {
      lines.push("", "## Risks", items.join("\n"));
    }
  }

  if (input.verification && input.verification.length > 0) {
    const items = input.verification
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => `- ${escapeMarkdown(neutralizeMentions(entry))}`);
    if (items.length > 0) {
      lines.push("", "## Verification", items.join("\n"));
    }
  }

  if (input.references && input.references.length > 0) {
    const items = input.references
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => `- ${escapeMarkdown(neutralizeMentions(entry))}`);
    if (items.length > 0) {
      lines.push("", "## References", items.join("\n"));
    }
  }

  // Footer with the universal /plan resolution slash commands so the
  // user knows how to act on this plan from any channel that received
  // the file (Telegram primarily, but future Discord/Slack mirror the
  // same pattern via PR-11's universal slash commands).
  const generatedAt = (input.generatedAt ?? new Date()).toISOString().slice(0, 10);
  lines.push(
    "",
    "---",
    `_Generated by OpenClaw on ${generatedAt}. Resolve with \`/plan accept\` | \`/plan accept edits\` | \`/plan revise <feedback>\`._`,
  );

  return lines.join("\n") + "\n";
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
 *
 * PR-11 deep-dive review: also neutralize Discord raw user mentions
 * `<@123>` / `<@!123>` / `<@&123>` (role mention) by inserting U+200B
 * between `<` and `@`. Discord parses these as pings; an agent
 * embedding such a string in a plan step would otherwise notify the
 * named user/role on `/plan restate`.
 *
 * Channel coverage: Telegram (HTML), Discord/Matrix/Mattermost
 * (markdown), Slack (mrkdwn — handled separately by escapeSlackMrkdwn
 * via U+FE6B on every `@`), plaintext (iMessage/Signal/SMS).
 */
function neutralizeMentions(text: string): string {
  return text.replace(/@(channel|here|everyone)\b/gi, "@\uFE6B$1").replace(/<@/g, "<\u200B@");
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
