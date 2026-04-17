---
name: openclaw-security-fix-driver
description: End-to-end driver for fixing open security issues in the OpenClaw repo. Use whenever the user asks to "work through" or "drive" security issues, "fix the top N security bugs", "land security fixes", "clear the security backlog", "triage and patch security reports at scale", or to coordinate a multi-issue security fix campaign. Also use when the user names a specific security issue to fix end-to-end (for example "fix issue #40297", "drive openclaw/openclaw#40297 through merge", "fix this security bug: <URL>", or "take issue 40297 through the full flow") — in that case the skill runs in single-issue mode and skips discovery. Also use for requests that ask to rank open security issues by importance, batch-fix them, and drive PRs through review and merge. Always delegate PR mechanics to `$openclaw-pr-maintainer`, GHSA-class work to `$openclaw-ghsa-maintainer`, and close/hardening-only decisions to `$security-triage`.
---

# OpenClaw Security Fix Driver

This skill orchestrates a safe, resumable security fix workflow in the OpenClaw repo. It is **not** a replacement for maintainer skills — it calls them. Think of it as a control loop that runs the four phases end-to-end:

1. **Discover & rank** the top open security issues (batch mode only)
2. **Fix** each one (root cause → code → tests → local gates)
3. **Land** via the existing PR maintainer flow (review nudge → merge)
4. **Report** a manager-facing summary per merged fix

Every long-running step is checkpointed to a ledger on disk so work can resume across sessions without redoing it.

## Modes of operation

The skill runs in one of two modes, chosen from how the user framed the request.

### Batch mode (default)

The user wants to work many issues — phrasings like "fix the top security issues", "clear the security backlog", "drive the top N security bugs through merge." Run **all four phases**, starting at Phase 1. This is the mode described through most of this doc.

### Single-issue mode

The user named a specific issue — an issue number (`#40297`, `issue 40297`), a GitHub URL (`https://github.com/openclaw/openclaw/issues/40297`), or a GHSA id (`GHSA-xxxx-xxxx-xxxx`). Examples:

- "fix issue #40297"
- "drive openclaw/openclaw#40297 to merge"
- "take this security bug end-to-end: <URL>"
- "run the security fix flow on GHSA-xxxx-xxxx-xxxx"

In single-issue mode, **skip Phase 1 entirely**. Jump straight to the fix loop for the named issue. The rest of the flow is identical: same ledger, same checkpoints (C2–C6), same delegation to `$openclaw-pr-maintainer` / `$openclaw-ghsa-maintainer`, same manager-facing report.

Single-issue mode steps:

1. **Parse the target.** Extract the issue number (or GHSA id) from the user's message. Reject ambiguous input — do not guess. If the user mentioned a repo-qualified ref (`owner/repo#N`) that is not `openclaw/openclaw`, stop and ask.
2. **Load the issue** with `gh issue view <N> --repo openclaw/openclaw --json number,title,body,labels,url,state,createdAt,updatedAt,author` plus `--comments`. For a GHSA id, use `gh api /repos/openclaw/openclaw/security-advisories/<GHSA>` and hand the issue to `$openclaw-ghsa-maintainer`.
3. **Verify the security framing.** Read the body and comments against the "Deep-read signals" in `references/ranking.md`. If the report is clearly out of scope (private-LAN `ws://`, prompt injection in workspace memory, already-trusted precondition), stop and hand to `$security-triage` — do **not** fabricate a fix just because the user named the issue.
4. **Record in the ledger.** Upsert the issue with `scripts/ledger.py upsert-issue` at `stage: queued`, mode marker `"invocationMode": "single-issue"`, and the importance score computed per `references/ranking.md`. If the issue is already present (prior campaign run or resume), reuse the existing entry and continue from its current stage per `references/ledger.md`.
5. **Enter Phase 2 (Per-issue fix loop).** From here, behavior is identical to batch mode: root-cause → checkpoint C2 → implement → test at C3 → hand to `$openclaw-pr-maintainer` for Phase 3 → write the manager report in Phase 4.

In single-issue mode the bulk-action checkpoint (**C4**) effectively collapses — there is no "batch of 5", so C4 never fires unless the user later asks the skill to take on more issues.

**When to use the delegated skills directly instead of this skill:**

- Just a triage close/keep decision, no fix intent → `$security-triage`
- Reviewing an existing PR someone else filed → `$openclaw-pr-maintainer`
- Cutting a release after fixes land → `$openclaw-release-maintainer`

Use this skill when the user wants the fix driven through — whether one issue or many.

## Non-negotiable safety rules

These come from the repo's `CLAUDE.md` and are load-bearing for this workflow. Do not relax them without explicit user approval in the chat.

- Use repo-root-relative file paths in all responses (e.g. `src/telegram/index.ts:80`), never absolute paths.
- Respect `CODEOWNERS` on security-sensitive surfaces (pairing, auth, gateway ingress, secrets, crypto). Do not drive-by-clean files covered by security `CODEOWNERS` unless a listed owner is already reviewing with you.
- Do **not** modify the `.git` folder. Do **not** touch git worktrees, stashes, or branch checkouts unless the user explicitly asks.
- Never use `--no-verify`, `--no-gpg-sign`, or `--amend` after a hook failure. Fix the root cause and create a new commit.
- Never force-push `main` and never create merge commits on `main`; rebase onto latest `origin/main` before push.
- For bulk close/reopen that would affect more than 5 PRs or issues, stop and ask for explicit confirmation with the exact count.
- Treat release and `npm publish` as explicit-approval actions even after all fixes land.
- Use `scripts/committer "<msg>" <file...>` for commits so staging stays scoped; avoid broad `git add -A`.

## Checkpoints that pause for approval

The driver pauses at each of these points and waits for the user in the chat before proceeding. This is the main knob that keeps long runs safe.

| # | Checkpoint | What to confirm |
| - | ---------- | --------------- |
| C1 | Batch kickoff | The ranked top-N list, the ceiling `N`, and whether to run end-to-end or stop after each issue |
| C2 | Per-issue fix | The root-cause analysis and the proposed patch, before writing code |
| C3 | Pre-PR | Targeted tests green, `pnpm check` green, and `pnpm build` when the touched surface warrants |
| C4 | Bulk action (>5) | Any cross-issue action that would file, close, or comment on more than 5 PRs/issues |
| C5 | Reviewer nudge | Which accounts to tag, and the wording of the nudge |
| C6 | Release-adjacent | Anything that would cut a tag, bump `package.json`, or call `npm publish` |

Checkpoints exist because the cost of a mistake on a security PR (an unreviewed force-land, a premature advisory disclosure, a bad patch merged) is much higher than the cost of a short wait.

## Phase 1 — Discover and rank

> **Batch mode only.** In single-issue mode, skip this phase entirely (see "Modes of operation" above) and go straight to Phase 2 with the user's named issue. The single issue still gets scored per `references/ranking.md` so the ledger entry is comparable to batch runs, but no wide discovery happens.

The goal of this phase is a deterministic top-N list of open security issues, scored by importance, with a short justification per issue. **Labels alone are not enough** — many real security issues in this repo are filed without a `security` label, and many labeled `security` are hardening-only noise. Discovery and ranking both run in two passes: a cheap candidate sweep, then a content-aware deep read.

### Pass 1 — Wide candidate sweep

Cast a wide net, even at the cost of false positives (Pass 2 will filter):

```bash
.agents/skills/openclaw-security-fix-driver/scripts/rank_security_issues.sh --limit 300
```

The helper collects candidates from multiple signals and deduplicates by issue number:

1. **Label variants** — `security`, `type:security`, `severity:*`, `CVSS-*`, `ghsa`, `vuln`, `hardening`, `auth`, `crypto`, `pairing`
2. **Title/body keyword search** via `gh search issues` for terms like `RCE`, `auth bypass`, `signature`, `HMAC`, `CSRF`, `SSRF`, `injection`, `path traversal`, `token leak`, `spoof`, `impersonat`, `privilege escalation`, `sandbox escape`, `TOCTOU`, `replay`, `MITM`, `deserializ`, `prototype pollution`
3. **Surface mentions** — issues that reference `CODEOWNERS`-covered security paths (`src/gateway/auth*`, `src/channels/**/pairing*`, `src/channels/**/secrets*`, webhook verification, signature routines)
4. **GHSA cross-reference** — `gh api /repos/openclaw/openclaw/security-advisories` so the driver sees advisories even when no public issue exists

Pass 1 emits a candidate JSON array on stdout. Treat its preliminary score as a **rough bucket**, not the final rank.

### Pass 2 — Deep read and re-score

Labels and keyword matches miss two real cases:

- A report filed as a "bug" with no `security` label that is actually an auth bypass (needs promotion).
- A report labeled `security` that turns out to be a hardening suggestion or an out-of-scope prompt-injection claim (needs demotion or skip).

For each candidate, **read the issue in full** before locking in a score:

1. Load the issue body, all comments, and any linked GHSA:

   ```bash
   gh issue view <N> --repo openclaw/openclaw --json number,title,body,labels,url,createdAt,updatedAt,author,comments
   ```

2. Read the content against the signals in `references/ranking.md` §"Deep-read signals". The key questions:

   - **Is there a concrete trust-boundary crossing described?** (unauth → auth, LAN → loopback, plugin → core, sandbox escape). Vague "could be exploited" language without a mechanism is a demotion signal.
   - **Is there a reproducer or a clearly-named file/function?** Reproducers + code pointers raise confidence and thus rank.
   - **Does the reporter distinguish trust-boundary bypass from hardening?** If the report is explicit that it's hardening-only, treat it as hardening.
   - **What shipped version does it apply to?** Use `git tag --sort=-creatordate | head -1` and `git show <tag>:<path>` to verify the bug exists in the latest released bytes, not just `main`.
   - **Are there disqualifier matches?** `SECURITY.md` out-of-scope classes (private-LAN `ws://`, prompt injection in workspace memory files, "attacker already has operator admin") → skip to triage, regardless of how serious the body sounds.
   - **Reporter context** — a detailed report with CVSS vector + PoC from an experienced reporter outranks a one-line "this seems insecure" even at the same keyword-match level.

3. Re-score using the rubric. The Pass-1 score may go up, go down, or stay the same. Save both the Pass-1 and Pass-2 scores in the ledger so re-ranks are auditable.

### Presenting the rank

After Pass 2, sort by final score (tie-break per `references/ranking.md`) and present the top 10 in chat with:

- Rank number, issue number, final total score and component breakdown
- One-sentence "why this rank" that cites the specific signals (keyword + code pointer + shipped-tag evidence + any demotions)
- URL

The full ranked JSON — including Pass-1 vs Pass-2 deltas — goes into the ledger. This is what makes the rank defensible if a reviewer asks "why did you prioritize X over Y?"

### GHSA handoff

GHSA-class issues (surfaced via `gh api /repos/openclaw/openclaw/security-advisories` or labeled `ghsa`) must be handed to `$openclaw-ghsa-maintainer` for the actual patch/publish flow. The driver keeps them in the ledger and tracks status, but it does not drive the patch itself.

### Checkpoint C1

Show the user the top 10 with breakdowns and confirm scope: how many to work, serial vs parallel, and whether GHSA entries should be forwarded to the GHSA maintainer skill immediately. If the user disagrees with a specific rank, re-open Pass 2 for that candidate rather than tweaking numbers ad hoc — the goal is that the rank can always be explained from the evidence.

## Phase 2 — Per-issue fix loop

For each issue in the confirmed batch, follow `references/fix-workflow.md`. The short version:

1. **Read the issue and linked code** verbatim before forming a theory. Quote the report and quote the implicated code with repo-root-relative file:line refs.
2. **Decide disposition** against the close bar from `$security-triage`:
   - Close / hardening-only / out of scope → hand off to `$security-triage` (record `skipped: triage` in the ledger) and move on.
   - Real bug on the shipped surface → continue to fix.
3. **Write the root-cause analysis** in 3–8 lines. Explain the trust boundary that was crossed, not just the symptom.
4. **Propose the patch** and pause at **C2** for approval. Include: files touched, why this fix is minimal and correct, risk of regression, and test plan.
5. **Implement** using `Edit`/`Write`. Keep changes scoped; follow the architecture boundaries from `CLAUDE.md` (plugin-sdk seams, channel boundary, etc.).
6. **Test** with the narrowest meaningful gate first, then widen:
   - `pnpm test <path-or-filter>` for the touched area
   - `pnpm check` before pushing
   - `pnpm build` when the change can affect build output, packaging, lazy loading, module boundaries, or published surfaces (this is the explicit `CLAUDE.md` hard gate)
   - If `pnpm tsgo` fails, triage by coherent surface per `CLAUDE.md`, not raw error count
7. **Regression test** — if you can add one that would have caught the bug, add it. If you genuinely cannot, say so explicitly in the PR body and the ledger.
8. Pause at **C3** with the green gate results before commit.

Prompt-cache and dynamic-import hygiene from `CLAUDE.md` apply here too: if the fix touches model/tool payload assembly, make ordering deterministic and prefer tail-mutating truncation; if it touches lazy-loading boundaries, re-check `pnpm build` for `[INEFFECTIVE_DYNAMIC_IMPORT]` warnings.

## Phase 3 — Land via the PR maintainer

Invoke `$openclaw-pr-maintainer` for the actual PR lifecycle. This skill should supply the maintainer skill with:

- A clean, scoped commit staged via `scripts/committer "<msg>" <file...>`
- A PR title and body following `.github/pull_request_template.md`, including:
  - Issue link, affected versions, trust-model framing
  - Root-cause analysis (from Phase 2)
  - Fix summary and why it is minimal
  - Verification (`pnpm test`, `pnpm check`, `pnpm build` outputs, and any manual steps)
  - Risk/rollback notes
- A short changelog entry (only for user-facing security changes; pure test/meta changes do not need one per `CLAUDE.md`)

Push and PR filing follow the `/landpr` global prompt flow referenced in `CLAUDE.md`. Do not create merge commits on `main`; rebase.

**Reviewer nudging** is a separate checkpoint (**C5**). Do not tag individuals without the user's confirmation of the reviewer set. When nudging:

- Tag the relevant `CODEOWNERS` for the touched path and, for GHSA-derived fixes, the advisory owner.
- Keep the nudge message factual: what changed, what tests ran, what is blocking review. Do not pressure individual reviewers beyond one polite follow-up per business day.
- "Permitted merge account" escalation (asking a maintainer with merge rights to land) only happens after two reviewer-acked approvals, all required checks green, and **C4** approval if this is part of a bulk action.

For GHSA-class issues, the entire land phase is owned by `$openclaw-ghsa-maintainer`. The driver's job is to record the handoff and watch for completion in the ledger.

## Phase 4 — Manager summary and ledger update

After each merge, write a summary to `.agents/state/security-fix-driver/reports/<issue-number>.md` using the template in `references/reporting.md`. The summary is the manager-facing artifact; it should be short, plain-English, and linkable.

Then update the ledger entry for that issue to `merged` with:

- PR URL and merged commit SHA
- Land date
- Surface/severity tags
- Link to the written report

Keep one rolling `.agents/state/security-fix-driver/reports/INDEX.md` that lists every merged fix in the campaign. That index is the first thing the manager reads.

## The ledger

The ledger is the persistence layer that makes long runs safe to resume. It lives at:

```
.agents/state/security-fix-driver/ledger.json
```

Schema, state machine, and atomic-update contract are in `references/ledger.md`. Use `scripts/ledger.py` for all reads/writes so updates stay atomic. Never hand-edit the ledger mid-run.

Because `.agents/state/` is local to the developer, add it to `.git/info/exclude` (not `.gitignore`) per the `CLAUDE.md` rule about local-only ignores. The driver's first run prints the one-line append command for the user.

## Idempotent resume

When the skill starts, it does this in order:

1. Load the ledger and list in-flight issues by state
2. For each, show the user the current state and the next action
3. Ask which to continue, which to skip, which to retry
4. Resume the loop from the lowest unfinished stage for each selected issue

Resume never silently redrafts a PR or reopens a closed issue. If an issue's PR is already open, the driver switches to `$openclaw-pr-maintainer` for review/land actions rather than filing a new PR.

## Error handling

Common failure modes and how to react:

- **Tests fail after the fix**: do not mark `tested`. Record the failing test name and message in the ledger `notes` and pause for the user.
- **Hook fails at commit**: do **not** `--amend` or `--no-verify`. Fix the reported issue, re-stage, and create a new commit.
- **PR CI fails**: read the failing job, treat as a new sub-fix in the same issue's ledger entry. Do not squash-force-push without the user's approval.
- **Reviewer requests changes**: apply via new commits on the branch; do not rebase-squash until approval is final and merge is imminent.
- **Merge conflicts on `main`**: rebase locally, rerun the relevant gates, force-push the branch (never `main`).
- **Issue turns out to be duplicate or invalid mid-fix**: stop, hand to `$security-triage`, record `skipped: <reason>` in the ledger.

## What NOT to do

- Do not open more than one PR per issue unless the user explicitly asks.
- Do not combine multiple unrelated security fixes into one PR; one fix per PR keeps review and bisection sane.
- Do not push `main` directly, even for trivial fixes.
- Do not modify release, publish, or `package.json` version fields without **C6** approval.
- Do not tag reviewers or post "bump" comments beyond the cadence agreed at **C5**.
- Do not include real phone numbers, user data, or live credentials in PR bodies, reports, or tests per `CLAUDE.md`.

## Reference files

- `references/ranking.md` — importance scoring rubric with worked examples
- `references/fix-workflow.md` — per-issue playbook with gate commands
- `references/reporting.md` — manager-facing summary template
- `references/ledger.md` — ledger JSON schema, state machine, atomic-update contract

## Scripts

- `scripts/rank_security_issues.sh` — `gh` query + deterministic ranking
- `scripts/ledger.py` — atomic ledger read/write helper
