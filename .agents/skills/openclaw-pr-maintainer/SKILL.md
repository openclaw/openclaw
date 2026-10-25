---
name: openclaw-pr-maintainer
description: "Review, triage, repair, or land OpenClaw issues and pull requests with current-source evidence and the native maintainer workflow."
---

# OpenClaw PR Maintainer

- Requested issue/PR operation only. Root `AGENTS.md`: repair, product, source-trust, approval policy. This skill: GitHub workflow and maintainer authority.
- Pasted ref ≠ publication permission or scope expansion.

## Maintainer authority

- **Red `main` is an emergency, not an unrelated landing prerequisite.** Push proven red-`main` fixes directly to `main` within repair scope. For a scoped maintainer instruction to land despite unrelated/pre-existing CI, select the [inherited-failure exception](references/landing.md#authorized-pre-existing-failures); do not demand special wording, renewed approval, or repair/rerun unrelated main CI first. Human authorization, failure evidence, and the protected writer's execution capability are separate checks.
- Repair-and-land authority covers internal scheduling, database admission, lifecycle design, risk, verification. In-task bug fixes (including compatible SDK fixes) and backed-up repairs removing only invalid or unreachable data need no renewed approval.
- Bulk close/reopen above 50 items needs explicit count and scope.
- Advisory workflows need explicit security request.
- Peter-instructed Team updates use the [release deployer](../update-team-server/SKILL.md); never edit live state outside its owner. Notify Night Watch of every deploy/restart; it coordinates restart timing, not update approval.

## Select the scope

- **Review/triage/list:** read-only; explain change/findings/proof/uncertainty. Edits, assignment, labels, comments, closes need authority.
- **Fix only:** investigate/repair/validate locally; publication needs ship/land or scoped equivalent.
- **Land/ship/autonomous repair:** source proof → review → native submission → verified merge. Track pending requests; repair PR-caused CI/conflicts under same authority, route attributed inherited CI through the exception above. Accepted auto-merge ≠ done. Preserve credit/unrelated work; root gates remain, no repeat routine permission.
- **Queue/discovery:** read [triage](references/triage.md). Batch live reads/shared discovery; named PR ≠ queue sweep.
- **Author/regression attribution:** [author and provenance research](references/attribution.md); account age/history conditional.
- Lead hands-on; bounded useful workers, serialized checkout/refs + GitHub writes. No user-owned app tasks hiding internal subtasks. Preserve stalled worker patches/claims/proof before takeover/reassignment.

## Inspect the actual item

- Start `git status -sb`; preserve unrelated work. Local `gitcrawl` → PATH `ghx`, narrow live JSON. Stale/missing archive → `ghx`, no broad sync. PR source: `ghx pr view/diff` + checkout, not web search.

```bash
ghx pr view <pr> --repo openclaw/openclaw \
  --json number,title,state,body,author,assignees,baseRefName,headRefName,headRefOid,files,comments,reviews
ghx issue view <issue> --repo openclaw/openclaw \
  --json number,title,state,body,author,assignees,comments
```

- Assignment: [triage](references/triage.md#assignment), before deep work. Mention other assignees; preserve ownership. Account/activity research conditional.

## Establish the outcome

- Read owner, entry points, callers, siblings, tests, docs, history, current main; inspect determining dependency contracts. Codex: root's personal source inspection. Contrary evidence → investigate before defending. No invented matrix/alternative.
- **Already fixed:** prove current-main repair; canonical commit/PR + matching source/runnable proof. Closure authority → comment evidence + close; otherwise report.
- **Real defect:** reproduce → repair owning invariant → prove path/siblings. Simplification over symptom guard; size/LOC ≠ correctness gate.
- **Useful PR:** improve editable branch; unsafe → authorized credited replacement before closure. Replaced ancestry → maintainer-owned replacement, never squash contributor PR.
- **Uncertain/product decision:** state gap; no speculative merge/automatic out-of-scope close.
- Proof + source-trust/host route: `$openclaw-testing`, [landing](references/landing.md#red-main-and-inherited-failures). Focused proof → ready PR; PR CI = broad proof. Prefer bounded local proof on a qualified, available host. Deliberate remote proof can cover expensive checks or environment gaps; queues → stop task-owned allocation, use PR CI or a safe local scope, preserve uncovered requirements. Never execute untrusted source locally. Optional live gaps → meaningful boundary proof + limitation; explicit live, external API, authenticated-risk proof mandatory. Mocks/skips/old head ≠ live.
- Behavioral changes: [boundary-proof contract](../../../docs/help/testing/writing-tests.md#prove-behavior-at-the-owning-boundary) + `$test-audit`. Requested behavior and repo standards: check separately.

## CODEOWNERS review

- `CODEOWNERS` routes review; inspect live enforcement. Restricted/security paths + material product/behavior/security/ownership changes need listed-owner involvement.
- ownership/review governance: verified active organization-admin direction also qualifies; repository admin/bypass alone does not. Neither route waives enforced reviews.

## Review and publish

- Before committing or landing nontrivial code: fresh review through permitted workflow; resolve actionable findings unless user opts out. Actionable = likely or high-impact; decline unlikely, recoverable edge cases whose fix adds disproportionate complexity, with one-line reason.

- Nontrivial code commit/landing: `$autoreview`; resolve verified actionable findings. Review-only: independent pass only when requested, no extra mandatory CLI pass.
- Reopen review for substantive changes/unresolved concerns, not patch-identical rebase/mechanical head change. Address real human/bot findings; explain rejections. Bot scores/Rank-up lists create no separate obligations. ClawSweeper advisory; never wait for comment to land.
- Current PR template: plain problem/impact; inventories in diff/details. Keep risks, migrations, actions, proof, gaps, credit current; explain material tradeoffs. No invented internal-only user benefit or universal LOC/provenance/alternate-fix essays.
- `CHANGELOG.md` release-owned; release-note context in PR/commit. Agent transcripts only on explicit request.
- Public mutation: verify author/committer + writer. Use `ghx` with real `--body-file <path>` payloads, never stdin (`--body-file -`, `--input -`, or `/dev/stdin`); the proxy does not forward stdin. Read changed bodies back with `ghx --no-cache` and verify exact nonempty bytes. Authorized scope only; update existing comment/body, no duplicates.
- Publication/merge: read [landing](references/landing.md) (media, exact-head CI, native workflow).
- Verify remote merge/closure + source. Report problem, owning change, proof/gaps, credit, linked final state in prose; worthwhile follow-ups only.

## Finalize and clean up

- Never remove worktree holding live session cwd, including yours or subdirectories. Child `cd`/cwd override does not move parent. Retain until owner exits/releases cwd; report path.
- Verified outcome → remove task logs, receipts, proof archives, `.crabbox`, scratch, finished worktrees via [native closeout](references/landing.md#recovery-and-closeout). No retention/archive/export/handoff just for removal.
- Remove created worktrees once work/PR lands, unless immediately needed next; never remove a live-cwd worktree.
- Every task: findings in chat/stdout; files only for deliverables/tool/proof/recovery needs, state purpose/reuse. Pre-merge proof mandatory; optional follow-ups never hold completion.
- Preserve requested deliverables/retention, unfinished source + necessary recovery state, active/live/unknown owners, credentials, agent state, shared dependencies.
