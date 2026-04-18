/**
 * Plan checklist renderer for the GPT-5 parity sprint.
 *
 * Takes structured plan step data and renders it as a native checklist
 * for each delivery surface. Channel adapters call
 * {@link renderPlanChecklist} with the appropriate format.
 *
 * Step shape matches the `update_plan` tool output (step, status,
 * activeForm) PLUS PR-9 Wave B1 closure-gate fields
 * (acceptanceCriteria, verifiedCriteria). The status union here includes
 * `cancelled` per PR-B (#67514) — `PLAN_STEP_STATUSES` in
 * `src/agents/tools/update-plan-tool.ts:24` is the authoritative list.
 * Callers map agent tool output into this shape; they may also provide
 * step text from heterogeneous sources (compaction snapshots, channel
 * adapters) where validation isn't pre-applied.
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
      // PR-C review fix (Copilot #3096459445 / #3096516846): apply
      // mention-neutralization the same way the html / markdown /
      // plaintext branches do, BEFORE the format-specific escape. This
      // lets `escapeSlackMrkdwn` drop its indiscriminate `@`
      // replacement (which mangled emails like `user@example.com`)
      // while still protecting `@channel` / `@here` / `@everyone` and
      // Discord-style `<@123>` raw mentions.
      const escaped = escapeSlackMrkdwn(neutralizeMentions(label));
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
  // PR-11 review fix (Codex P2 #3105075579): normalize the verified
  // set the same way criteria are normalized before comparison.
  // Pre-fix the comparison was raw-against-normalized — a criterion
  // verified upstream with equivalent text differing only by whitespace
  // / newline formatting would render as unchecked here, producing
  // inconsistent plan state in `/plan restate` and UI checklists.
  const normalize = (s: string) => s.replace(/[\n\r]+/g, " ").trim();
  const verified = new Set((step.verifiedCriteria ?? []).map(normalize));
  return criteria.map((rawCriterion) => {
    const criterion = normalize(rawCriterion);
    const isVerified = verified.has(criterion);
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
        // Same neutralizeMentions-before-escape pattern as the parent
        // step branch (PR-C review fix #3096459445 / #3096516846).
        const escaped = escapeSlackMrkdwn(neutralizeMentions(criterion));
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
      return `*${escapeSlackMrkdwn(neutralizeMentions(safeTitle))}*\n${checklist}`;
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

/**
 * Escapes Slack mrkdwn control characters using visually-similar
 * Unicode lookalikes instead of backslash escaping (which Slack renders
 * as visible noise in mrkdwn). Specifically:
 *   - `&` / `<` / `>` → HTML-entity encoded (Slack ignores these in
 *     mrkdwn but external markdown renderers may interpret them).
 *   - `*` → U+2217 (∗, asterisk operator) — prevents bold parsing.
 *   - `~` → U+223C (∼, tilde operator) — prevents strikethrough parsing.
 *   - `` ` `` → U+2018 (', left single quote) — prevents code-span.
 *   - `_` → U+FF3F (＿, fullwidth low line) — prevents italic parsing.
 *
 * Note: this differs from `extensions/slack/src/monitor/mrkdwn.ts`
 * which uses backslash escaping. The plan renderer optimizes for
 * READABILITY of agent-authored step text in human-visible Slack
 * channels (no `\*\_` noise); the Slack monitor processes
 * USER-AUTHORED content where exact-byte preservation matters more.
 * Both are valid escape strategies for their respective use cases.
 *
 * Mention protection (@channel/@here/@everyone, Discord-style `<@123>`)
 * is provided by `neutralizeMentions()` called at the render-branch
 * level, NOT here. This function is pure formatting-character escape.
 */
function escapeSlackMrkdwn(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*/g, "\u2217")
    .replace(/~/g, "\u223C")
    .replace(/`/g, "\u2018")
    .replace(/_/g, "\uFF3F");
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
 * "Deploy `rm -rf /`", "[click](evil)", or "Deploy ~~prod~~ now" doesn't
 * render as a code span, link, or break out of the cancelled-step
 * `~~...~~` strikethrough wrapper.
 *
 * PR-C review fix (Codex P2 #3096528415 / Copilot #3096792952): `~` is
 * in the escape set so that step text containing `~~` doesn't close
 * the outer strikethrough wrapper used for cancelled steps. Without
 * this, `Deploy ~~prod~~ now` rendered as `~~Deploy ~~prod~~ now~~`
 * which markdown parses as `~~Deploy ~~`/`prod`/`~~ now~~` — broken
 * cancelled rendering.
 */
function escapeMarkdown(text: string): string {
  // Order matters: backslash first so we don't re-escape our own escapes.
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|~]/g, "\\$&");
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

/**
 * PR-C review fix (Copilot #3096792992): bounded set with FIFO eviction
 * to prevent unbounded growth in long-running gateway processes if a
 * malformed/malicious upstream produces many distinct statuses over
 * time. Once `WARNED_STATUSES_MAX` is reached, the oldest tracked
 * status is evicted on each new insert (Set iteration order is
 * insertion order in ES2015+, so the first key is the oldest).
 */
const WARNED_STATUSES_MAX = 64;
const warnedStatuses = new Set<string>();
function warnUnknownStatus(status: string): void {
  if (warnedStatuses.has(status)) {
    return;
  }
  if (warnedStatuses.size >= WARNED_STATUSES_MAX) {
    const oldest = warnedStatuses.values().next().value;
    if (oldest !== undefined) {
      warnedStatuses.delete(oldest);
    }
  }
  warnedStatuses.add(status);
  console.warn(
    `[plan-render] Unknown plan step status "${status}", falling back to pending rendering.`,
  );
}
