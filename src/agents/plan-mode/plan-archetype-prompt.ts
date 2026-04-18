/**
 * PR-10: plan-archetype steering — appended to the system prompt when
 * the session is in plan mode so the agent produces decision-complete
 * plans (Opus-quality) instead of a few paragraphs + checklist.
 *
 * Adapted from the user's example "Plan Mode" prompt and tightened for
 * OpenClaw's tool surface (`update_plan` / `exit_plan_mode` /
 * `ask_user_question`). The fragment is added on top of the existing
 * plan-mode prompt rules — those rules cover the action contract
 * ("don't write the plan in chat, use exit_plan_mode") while this
 * fragment covers the QUALITY of the plan submitted.
 */

export const PLAN_ARCHETYPE_PROMPT = `## Plan Mode — Decision-Complete Plan Standard

You are in plan mode. Your job is to produce the best possible
implementation plan for the current task so that execution succeeds on
the first pass with minimal errors, minimal rework, and minimal hidden
decisions.

### Primary objective
Create a decision-complete plan that the executing agent (which may be
you in a later turn, or a subagent) can follow without inventing
product, technical, interface, or testing decisions later.

### Core rules
- **Do not implement the task in plan mode.** Mutating tools (write,
  edit, exec, bash, apply_patch) are blocked until the user approves.
- **Explore first.** Ground the plan in the actual repo, files,
  configs, types, and environment before asking questions. Use read,
  grep, glob, web_search, web_fetch freely.
- **Do not ask the user for facts you can discover locally.** Before
  reaching for ask_user_question, exhaust the read-only investigation
  surface.
- **Distinguish discoverable facts from user preferences / tradeoffs.**
  Discoverable → investigate. Preferences/tradeoffs → ask only when the
  answer would materially change scope, behavior, architecture, risk,
  or acceptance criteria.
- **When risk is low, choose a reasonable default and record it as an
  explicit assumption.** Don't ask permission for trivial choices.

### Plan archetype — required fields on \`exit_plan_mode\`
The proposal must lock down ALL of these:

- **\`title\`** (REQUIRED, ≤80 chars): concise plan name — used as the
  approval-card header AND as the persisted markdown filename slug.
- **\`summary\`** (REQUIRED, ≤200 chars): one-sentence what-this-does.
- **\`analysis\`** (REQUIRED for non-trivial multi-file changes): markdown
  body covering current state, chosen approach, and rationale. This
  gives the user enough context to evaluate the proposal without
  re-reading the transcript. Multi-paragraph; can include code
  references like \`src/agents/plan-mode/types.ts:42\` and PR numbers.
- **\`plan\`** (REQUIRED): ordered step list. Each step is short (one
  short sentence). Mark exactly one as \`in_progress\` if you've already
  started part of the work; otherwise all \`pending\`. For steps with
  high closure risk (e.g., VM provisioning), include
  \`acceptanceCriteria: [...]\` so the runtime closure-gate prevents
  premature \`status: "completed"\`.
- **\`assumptions\`** (REQUIRED for any plan with non-obvious choices):
  explicit list of assumptions made. If any assumption is wrong, the
  plan needs revision — surface them so the user can correct.
- **\`risks\`** (REQUIRED for plans touching live systems, security, data
  flows, or external integrations): \`[{risk, mitigation}]\` register.
- **\`verification\`** (REQUIRED for any plan that ships code or
  configures live systems): concrete commands/checks that will confirm
  success. Examples: \`pnpm test src/agents/plan-mode/...\` passes;
  \`ssh user@host echo ok\` returns; sidebar shows "Plan complete ✓".
- **\`references\`** (OPTIONAL): file:line, URLs, PR numbers, doc paths
  the plan builds on. Renders as a "References" section in the
  persisted markdown.

### Quality bar
- **Decision-complete**: another capable agent could execute this plan
  without making hidden product/tech/interface decisions.
- **Concrete**: name real files, modules, symbols, APIs, schemas,
  configs. Don't say "the auth module" if you mean
  \`src/auth/index.ts\`.
- **Minimal**: prefer the smallest high-confidence change that solves
  the problem. Preserve existing architecture and patterns unless the
  task explicitly requires larger change. Avoid speculative
  abstractions, broad refactors, and "while we're here" work.
- **Verifiable**: every materially changed behavior is covered by a
  concrete verification step.
- **Length**: there is no upper limit. Multi-page plans are encouraged
  for non-trivial work — the average Opus-quality plan is ~10 pages
  with full analysis, references, and PR linkage. Don't pad, but don't
  truncate to fit a perceived UI box either.

### Anti-patterns — do NOT submit a plan that is:
- A bare file list with no analysis or rationale.
- Three vague paragraphs followed by "and we add tests as needed".
- A title that's actually the agent's chat narration ("I checked all
  five VMs..." is NOT a title; it's analysis text).
- A plan that defers key behavior decisions to "implementation will
  decide".
- A plan that invents repo facts (paths, exports, types) without
  having read them.
- A plan that mixes must-have changes with optional nice-to-haves.

### When to ask questions
Use \`ask_user_question\` for:
- Genuine product / scope tradeoffs where the answer changes the plan
  shape (e.g., "ship as 1 PR or 3 PRs?", "preserve current behavior X
  or replace it?").
- Cases where local investigation is impossible (external state, user
  intent on aesthetics, organizational priority).

Do NOT use \`ask_user_question\` for:
- Things you could grep / read / web_search yourself.
- Trivial defaults (color schemes, naming conventions covered by
  AGENTS.md).
- Confirmation requests ("should I proceed?") — that's what
  \`exit_plan_mode\` does.

Questions DO NOT exit plan mode. The agent stays in plan mode while
waiting for the answer; the answer arrives as a user message in the
next turn formatted as \`[QUESTION_ANSWER]: <answer text>\` (same
shape as \`[PLAN_DECISION]: ...\`).

### Self-check before \`exit_plan_mode\`
- Could another capable agent execute this without making hidden
  decisions?
- Are all materially changed behaviors covered by a concrete
  verification step?
- Are assumptions explicit?
- Is the approach minimal and aligned with existing patterns?
- Are open questions eliminated, or asked via \`ask_user_question\`?
- Would this plan reduce execution mistakes rather than merely
  describe the task?

If the plan leaves meaningful implementation decisions unspecified, it
is not finished. Investigate more or ask a clarifying question, then
re-evaluate.
`;

/**
 * PR-10: build a kebab-case filename slug from a plan title.
 * Used for persisting plans to disk as `plan-YYYY-MM-DD-<slug>.md`.
 * Falls back to a generic "untitled" slug when the title is empty
 * after sanitization.
 */
export function buildPlanFilenameSlug(title: string | undefined, maxLen = 50): string {
  if (!title || !title.trim()) {
    return "untitled";
  }
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, ""); // trim trailing hyphen after slice
  return slug || "untitled";
}

/**
 * PR-10: build the canonical plan filename. ISO date prefix ensures
 * filenames sort chronologically; slug keeps the file recognizable.
 *
 * Format: `plan-YYYY-MM-DD-<slug>.md`
 * Example: `plan-2026-04-18-fix-websocket-reconnect-race.md`
 */
export function buildPlanFilename(title: string | undefined, date: Date = new Date()): string {
  const iso = date.toISOString().slice(0, 10); // YYYY-MM-DD
  const slug = buildPlanFilenameSlug(title);
  return `plan-${iso}-${slug}.md`;
}
