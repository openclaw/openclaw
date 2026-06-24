---
name: openclaw-issue-reporter
description: "Draft high-signal OpenClaw issues with repro steps, redacted diagnostics, duplicate search, and approval before posting."
---

# OpenClaw Issue Reporter

Use this when:

- A user asks to create, draft, or file an OpenClaw issue.
- A user uses issue-reporting trigger words such as `create an issue`,
  `open an issue`, `file a bug`, `report this`, `upstream issue`,
  `GitHub issue`, `ClawSweeper`, `maintainer review`, `bug report`,
  `regression report`, or `this should be reported`.
- You notice an OpenClaw bug, regression, setup failure, confusing behavior,
  missing tool, plugin problem, docs gap, security concern, or feature gap
  during normal work and reporting it would likely help maintainers.

This skill optimizes issue intake. It does not implement fixes.

## Contract

- Default to draft-only. Do not post, comment, label, close, upload artifacts,
  or modify GitHub until the user approves the exact final public text.
- Gather as much useful evidence as you safely can before asking clarifying
  questions. Assume the baseline is a real issue that appeared during a session.
- Ask only for missing facts that materially affect the report and cannot be
  discovered from the local setup, public docs, logs, or GitHub.
- Prefer read-only diagnostics, public documentation, and public issue search.
- Keep the issue concise. Put each fact in the most relevant section once.
- Treat logs, config, screenshots, transcripts, and command output as private
  until reviewed and redacted.
- Separate observed facts from suspected causes.
- Before showing a final draft to the user for approval, ask a sub-agent or
  independent reviewer for a critical review focused on missing evidence,
  duplicate risk, overclaiming, privacy leaks, and whether the report is useful.
  Apply accepted findings before the user approval step.

## Fast Intake

First collect the smallest useful report shape from the current session, local
state, logs, command output, and public sources. Ask the user only for gaps you
cannot fill.

1. What did you try: prompt, command, UI action, or workflow?
2. What did you expect?
3. What happened instead?
4. When did it last work, if ever?
5. What changed recently: OpenClaw version, config, model/provider, plugin,
   channel, OS, network/proxy, or workspace instructions?
6. Does it reproduce in a new thread, clean workspace, retry, or with suspect
   plugins disabled?
7. What evidence already exists: logs, screenshots, terminal output, browser
   console, generated artifacts, failed commands, or prior attempts?

If the reporter is non-technical, ask plain questions and stop after 3-5
questions at a time. Do not dump a large command list at them.

## When You Notice The Issue Yourself

If you encounter the issue during normal work:

1. Finish or pause the original task at a sensible boundary.
2. Gather the evidence already available from that session.
3. Search public issues for likely matches.
4. If a report would add value, tell the user briefly:
   `I found what looks like an OpenClaw issue. I can draft a report with the
evidence from this session before anything is posted.`
5. Continue only in draft-only mode unless the user approves posting or
   commenting.

## Issue Type

Classify the report before gathering evidence:

- `bug`: current behavior is wrong.
- `regression`: a previously working behavior broke.
- `setup`: install, onboard, auth, migration, or first-run failure.
- `plugin`: installed plugin, bundled plugin, ClawHub skill, MCP, provider, or
  channel behavior.
- `security`: possible secret exposure, permission bypass, unsafe default, or
  data leak. Do not draft a public issue with vulnerability details. Follow
  `SECURITY.md` and draft a private disclosure for
  `https://github.com/openclaw/openclaw/security` instead.
- `feature`: new or changed behavior, not a current defect.
- `docs`: documentation is wrong, missing, or misleading.
- `support`: likely local setup question; draft a support-style issue only if
  repo maintainers need it.

## Evidence Ladder

Gather only the next useful layer. Stop when the issue is reproducible and
actionable.

1. Baseline:
   - OpenClaw version or commit.
   - Install method.
   - OS and architecture.
   - Entrypoint: CLI, desktop, channel, cron, plugin, or API.
   - Effective model/provider/auth profile when relevant.
2. Reproduction:
   - Minimal steps from a known state.
   - Expected behavior with source: docs, prior version, or direct observation.
   - Actual behavior with exact error, screenshot, or log excerpt.
   - Visual evidence for UI, browser, desktop, terminal, or rendering issues
     when it helps prove the behavior and can pass privacy review.
3. Scope checks:
   - New thread/workspace result.
   - Retry result.
   - Suspect plugin disabled, if safe and approved.
   - Current main/canary result only when relevant and feasible.
4. Diagnostics:
   - `openclaw --version`
   - `openclaw doctor`
   - `openclaw status --deep`
   - `openclaw models status` for model/provider issues.
   - `openclaw skills check` for skill loading issues.
   - Relevant recent logs, bounded to the incident window.

If a command does not exist or fails, record that as evidence instead of
inventing a replacement.

## Redaction Checklist

Before showing or posting any issue draft, check selected excerpts for:

- API keys, OAuth tokens, cookies, bearer headers, auth profiles, refresh tokens.
- Email addresses, hostnames, usernames, local home paths, and private domains
  unless they are necessary to the bug.
- Private prompts, conversation text, customer data, calendar/email content,
  file contents, screenshots, or transcripts unrelated to the failure.
- Full raw config. Prefer summarized config differences and relevant key names.
- Huge logs. Quote compact excerpts with timestamps and one or two surrounding
  lines.
- Screenshots and recordings. Crop or redact unrelated conversations, account
  data, email/calendar content, tokens, local paths, faces, customer data, or
  private workspace details before including them.

Never attach a full diagnostics directory to a public issue. Paste only reviewed,
redacted excerpts.

## Duplicate Search

Search before drafting a new issue. Use the best available public search path:
`gh`, GitHub web search, repository search, local cached issue indexes, or a web
search engine. Do not ask the user to paste links until you have tried the
available search paths yourself or search is blocked.

Search in this order:

1. Exact error message.
2. Symptom words.
3. Affected command, channel, plugin, provider, skill, or UI surface.
4. Recent release or regression version.
5. Closed issues and merged fixes for fixed or canonical threads.

Record:

- Queries used.
- Top likely matches.
- Why each candidate is or is not the same issue.
- Decision: new issue, useful comment on existing issue, no report, or unclear.

If an existing issue matches, be selective. Draft a comment only when the new
evidence adds something useful, such as a new reproduction, affected version,
environment, log excerpt, screenshot, workaround, regression boundary, or
current-main result. If the evidence only repeats what is already there, do not
draft a comment. Comments are GitHub writes and require explicit user approval
for the exact final text.

## Draft Shape

Use `{baseDir}/references/issue-template.md` as the starting point. Remove
sections that are not relevant, but keep:

- Summary.
- Impact.
- Environment.
- Reproduction steps.
- Expected behavior.
- Actual behavior.
- Evidence, including visual evidence when useful and approved.
- Similar issues searched.
- Unknowns and proof gaps.

For feature requests, replace reproduction with:

- Problem.
- Proposed behavior.
- Alternatives considered.
- Why this belongs in OpenClaw core, a plugin, ClawHub, or docs.
- Impact on fresh installs and existing users.

## Posting Boundary

Before user approval, run the critical review pass:

- Give the reviewer the draft and only the evidence needed to judge it.
- Ask for blocker/substantive issues only: missing repro, weak duplicate search,
  unsupported claims, privacy leaks, wrong security route, or low-value comment.
- Accept, adapt, or reject each finding before showing the draft to the user.

For `security` reports:

- Read `SECURITY.md` first.
- Use `https://github.com/openclaw/openclaw/security` for the private disclosure
  route.
- Draft only a private disclosure with the minimum necessary vulnerability
  detail, reproduction notes, affected versions, and impact.
- Do not create a public GitHub issue, public comment, public patch discussion,
  or public log excerpt containing unpatched vulnerability details.
- If the user wants a public placeholder, keep it non-sensitive and require
  explicit approval for that exact text.

For all other reports, after drafting, show:

- Issue title.
- Final public body.
- Exact excerpts or screenshots that would be posted.
- Duplicate-search decision.
- Sanitization status.

Then ask for one explicit approval to post or comment. If approved, use the
GitHub tool or `gh issue create` / `gh issue comment`. If not approved, leave the
draft in chat or a local file only.

## After Posting

If the repository uses ClawSweeper or another review bot, follow up after the
bot reviews the issue:

1. Read the bot review, labels, and any maintainer comments.
2. Summarize the verdict in plain language: quality rating, reproducibility,
   fix-shape clarity, duplicate status, maintainer-review need, and any explicit
   no-new-fix, maintainer-review, or next-action labels.
3. Decide whether useful follow-up exists:
   - If the bot asks for missing evidence and you can gather it safely, draft an
     update comment with that evidence.
   - If the bot found a duplicate, draft a short comment only if this session
     adds new information to the canonical issue.
   - If the bot says no new fix is wanted, maintainer review is needed, or the
     boundary is unclear, do not start implementation work from this skill.
   - If there is no useful new information, do not comment just to acknowledge
     the bot.
4. Any follow-up comment, label change, or artifact upload is a GitHub write and
   still needs explicit user approval for the exact final text or artifact.
