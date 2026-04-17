# Per-Issue Fix Workflow

This is the playbook that runs **once per issue** in the ranked batch. It assumes the batch was already approved at checkpoint C1 and the issue is not disqualified.

## Stage 0 — Load the issue

Always load from the authoritative source, not from a cached summary:

```bash
gh issue view <N> --repo openclaw/openclaw --json number,title,body,labels,url,state,createdAt,updatedAt
gh issue view <N> --repo openclaw/openclaw --comments
```

For GHSA-class issues (`ghsa` label or private advisory), **stop here** and hand to `$openclaw-ghsa-maintainer`. Record `stage: handed-off-ghsa` in the ledger and continue to the next issue.

## Stage 1 — Read code before writing any theory

Before forming a root-cause theory, read the exact implicated code. The reason is that security reports are frequently either mis-scoped (the bug is in a different file than claimed), already fixed on `main`, or describing a symptom whose cause is upstream of the quoted code.

Minimum reads:

- Every file named in the issue or its comments
- The direct callers of the implicated function (one hop)
- The relevant test file(s) for the surface
- The owning `AGENTS.md` / `CLAUDE.md` for boundary rules (`extensions/AGENTS.md`, `src/channels/AGENTS.md`, `src/plugins/AGENTS.md`, `src/plugin-sdk/AGENTS.md`, `src/gateway/protocol/AGENTS.md` as applicable)

Verify shipped state for any report that claims a specific version is affected:

```bash
git tag --sort=-creatordate | head
git tag --contains <suspected-fix-commit>  # if known
git show <latest-tag>:<path/to/file>        # spot-check the shipped bytes
```

If the bug is already fixed in the latest shipped tag, record `skipped: fixed-pre-release` and hand to `$security-triage` to close cleanly.

## Stage 2 — Root-cause analysis

Write 3–8 lines that answer four questions:

1. **Trust boundary**: which boundary is the attacker crossing (unauth → auth, LAN → loopback, plugin → core, etc.)?
2. **Mechanism**: what code enables the crossing? Quote with repo-root-relative `file:line`.
3. **Why the current guard fails**: where does the existing check not apply, or where is it missing?
4. **Minimal fix shape**: what is the smallest change that closes the boundary without breaking adjacent behavior?

Keep this analysis under 200 words. If it runs longer, the scope is probably too wide; split into multiple issues.

## Stage 3 — Propose the patch (checkpoint C2)

Present to the user:

- The root-cause analysis from stage 2
- The exact files you intend to touch (repo-root-relative)
- The diff shape ("add a signature check in `verifyInbound(...)`", not the full diff)
- The risk analysis (what adjacent behavior could regress, what public surfaces are touched)
- The test plan (what new test(s), what existing test(s) will cover the change)

**Wait for user confirmation** before writing code. This is the single most valuable gate in the campaign because a wrong fix merged into `main` costs far more than the five minutes of review here.

## Stage 4 — Implement

Rules:

- One fix per PR. No drive-by cleanup of unrelated files.
- Honor architecture boundaries: `src/plugin-sdk/*` is the public extension contract; core must stay extension-agnostic; channel plugins do not deep-import core.
- No `@ts-nocheck`, no `any` escape hatches, no inline lint suppressions unless the code is intentionally correct and the rule cannot express it (then comment the reason).
- Prefer `zod` / existing schema helpers at external boundaries.
- Do not introduce new runtime import cycles (`pnpm check:import-cycles` must stay green).
- If the change touches lazy-loading/module boundaries, keep dynamic and static imports separated via a `*.runtime.ts` seam.

## Stage 5 — Test (checkpoint C3)

Run gates in this order, from narrowest to widest:

```bash
# Narrow — direct coverage of the change
pnpm test <path-or-filter>

# Broad — format, lint, typecheck
pnpm check

# Build — only when the change can affect build output, packaging,
# lazy-loading/module boundaries, or published surfaces
pnpm build
```

Per `CLAUDE.md`: `pnpm build` is a **hard gate** for the categories above before pushing `main`-bound work.

Regression test rule: if a test written before the fix would have caught the bug, add it. If adding a test is genuinely infeasible (for example, the bug lives in an OS-specific code path the suite cannot run), say so explicitly in the PR body and in the ledger `notes`.

If `pnpm tsgo` fails, follow the `CLAUDE.md` triage: group by coherent surface, fix the root mismatch at the source-of-truth type, then rerun — not a big-bang sweep of every error.

Show the user the output of every gate that ran, and pause for confirmation before commit. This is **C3**.

## Stage 6 — Commit and open the PR

Commit with the repo-provided helper to keep staging scoped:

```bash
scripts/committer "security(<surface>): <short imperative summary>" path/to/file1 path/to/file2
```

Examples of good commit subjects:

- `security(gateway): enforce device-token binding on reconnect`
- `security(pairing): require signed nonce on non-loopback connect`
- `security(webhook): verify HMAC before invoking handler`

Then hand off to `$openclaw-pr-maintainer` for the PR lifecycle with the following inputs ready:

- PR title = commit subject
- PR body following `.github/pull_request_template.md`, including:
  - Linked issue (`Fixes #N`)
  - Affected versions / shipped tags
  - Root-cause analysis from stage 2
  - Fix summary and why it is minimal
  - Verification: exact gate commands run and their results
  - Risk / rollback notes
  - Test plan checkboxes
- Changelog entry **only** for user-facing behavior changes (pure test/meta changes skip the changelog per `CLAUDE.md`)

The PR maintainer skill owns the rest: close labels, search for related issues, evidence bar, reviewer nudging cadence, and landing.

## Stage 7 — Drive to merge (checkpoints C4, C5)

The driver's ongoing job after PR filing is:

1. Watch CI; if it fails, loop back to stage 5 with the failure as the next sub-fix.
2. Wait for reviews. Do **not** ping individual reviewers without **C5** approval of who to tag and the wording.
3. Respond to review feedback with new commits on the branch. No amend, no force-push until the final rebase right before merge (and only if the PR maintainer flow calls for it).
4. After required approvals and green CI, hand the merge action to `$openclaw-pr-maintainer` (the `/landpr` flow). Do not click merge yourself.
5. If the action is part of a batch and would cross the **>5 PR threshold**, stop and get explicit **C4** confirmation before continuing.

## Stage 8 — Post-merge

After merge, update the ledger:

```
stage: merged
prUrl: <url>
mergedSha: <sha>
mergedAt: <iso timestamp>
```

Then write the manager-facing report per `references/reporting.md` and append to `INDEX.md`. Only after the report is written and committed (or saved locally) does the driver move to the next issue in the batch.

## When to stop the whole campaign

Stop the loop and ask the user before continuing if any of these happen:

- A fix fails its gate twice with different root causes (signal that the scope is wrong)
- A reviewer requests a redesign rather than a tweak
- Two or more PRs in the batch hit merge conflicts on the same file (indicates shared surface work that wants one bigger fix)
- Any action would require touching a file covered by security `CODEOWNERS` that has not acknowledged the campaign
- Anything release-adjacent comes up (see **C6**)
