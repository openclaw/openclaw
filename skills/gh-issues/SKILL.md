---
name: gh-issues
description: "Fetch GitHub issues, select candidates, spawn background fix agents, open PRs, and optionally process PR review comments."
user-invocable: true
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["git", "gh"] },
        "primaryEnv": "GH_TOKEN",
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (brew)",
            },
          ],
      },
  }
---

# gh-issues

Use for issue-to-PR automation. Prefer `gh` CLI; fall back to `gh api` only when a high-level command lacks the needed field.

## Arguments

- positional `owner/repo`: optional; else infer from `git remote get-url origin`.
- `--label <label>`: filter.
- `--limit <n>`: default 10.
- `--milestone <title>`: filter.
- `--assignee <login|@me>`: filter.
- `--state open|closed|all`: default open.
- `--fork <owner/repo>`: push branches to fork, PR to source.
- `--watch`: poll issues + reviews.
- `--interval <minutes>`: default 5.
- `--dry-run`: list only.
- `--yes`: no confirmation.
- `--reviews-only`: skip issue fixing; handle PR reviews.
- `--cron`: spawn and exit; implies `--yes`.
- `--model <id>`: pass to workers when supported.
- `--notify-channel <id>`: optional final notification target.

## Phase 1: resolve repo

```bash
git remote get-url origin
if [ -z "${GH_TOKEN:-}" ]; then
  CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/openclaw.json}"
  GH_TOKEN=$(jq -r '.skills.entries["gh-issues"].apiKey // empty' "$CONFIG_PATH" 2>/dev/null || true)
  if [ -n "$GH_TOKEN" ]; then export GH_TOKEN; fi
fi
gh auth status
gh repo view OWNER/REPO --json nameWithOwner,defaultBranchRef
```

If `gh auth status` fails and `GH_TOKEN` is missing, stop and ask for GitHub auth/config.

Derived:

- `SOURCE_REPO`: issue repo.
- `PUSH_REPO`: fork if set, else source.
- `BASE_BRANCH`: source default branch unless user says otherwise.
- `PUSH_REMOTE`: `fork` in fork mode, else `origin`.

Stop on dirty worktree unless user confirms that workers should ignore uncommitted changes.

In fork mode, do not mutate remotes before confirmation or during `--dry-run`.

Verify auth/read access only:

```bash
gh auth token >/dev/null || test -n "${GH_TOKEN:-}"
gh repo view "$PUSH_REPO" --json nameWithOwner
git ls-remote --exit-code origin HEAD
```

## Phase 2: fetch issues

Build filters and fetch:

```bash
gh issue list --repo "$SOURCE_REPO" --state open --limit 10 --json number,title,labels,url,body,assignees,milestone
```

Add `--label`, `--milestone`, `--assignee`, `--state`, `--limit` as requested. `gh issue list` already excludes PRs.

If none found: report no matches. If `--dry-run`: show compact list and stop.

## Phase 3: avoid duplicate work

For each candidate:

```bash
gh pr list --repo "$SOURCE_REPO" --search "$SOURCE_REPO#<n>" --state open --json number,url,title,headRefName
gh pr list --repo "$SOURCE_REPO" --head "fix/issue-<n>" --state open --json number,url
gh api "repos/$PUSH_REPO/branches/fix/issue-<n>" >/dev/null
```

Skip candidates with an open PR, existing branch, or active local claim.

Claim file:

```text
${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/gh-issues-<owner>-<repo>.json
```

Expire claims older than 2 hours.
Create the parent directory before writing.

## Phase 4: confirm

Unless `--yes` or `--cron`, ask user to choose:

- `all`
- comma-separated issue numbers
- `cancel`

After confirmation, in fork mode, configure the push remote before handing work to agents:

```bash
gh auth setup-git
git remote get-url fork || git remote add fork "https://github.com/$PUSH_REPO.git"
git remote set-url fork "https://github.com/$PUSH_REPO.git"
git ls-remote --exit-code fork HEAD
```

## Phase 5: spawn workers

Launch up to 8 background workers. Do not block on each worker when `--cron`.

Before each spawn, write a claim for `SOURCE_REPO#<n>` with the current ISO timestamp. After a worker reports PR/failure, remove or update the claim. This prevents watch/cron overlap before a branch or PR exists.

Worker prompt must include:

- issue URL, title, body, labels.
- `SOURCE_REPO`, `PUSH_REPO`, `BASE_BRANCH`, `PUSH_REMOTE`, fork mode.
- target branch `fix/issue-<n>`.
- required proof and PR body.
- notification route.

Worker instructions:

```text
Use gh and git. Do not handwave.
Checkout/create fix/issue-<n> from BASE_BRANCH.
Implement minimal fix.
Run relevant tests.
Commit with conventional message.
Push to PUSH_REMOTE.
Open PR against SOURCE_REPO BASE_BRANCH.
PR body: What Problem This Solves + Why This Change Was Made + User Impact + Evidence + visible Fixes SOURCE_REPO#<n>.
Report PR URL or failure reason.
Send completion/failure with openclaw message send if route provided.
```

Use `coding-agent` launch rules when available.

## Phase 6: collect

Poll workers with `process` or task registry. Report:

- issue number + title.
- status: PR opened, skipped, failed, timed out.
- PR URL or reason.

Notify channel only with final compact summary.

## Reviews-only / watch reviews

Discover open PRs:

```bash
gh pr list --repo "$SOURCE_REPO" --state open --json number,title,url,headRefName,reviewDecision \
  --jq '[.[] | select(.headRefName | startswith("fix/issue-"))]'
```

Fetch review threads/comments:

```bash
gh pr view <n> --repo "$SOURCE_REPO" --json url,headRefName,comments,reviews
gh api "repos/$SOURCE_REPO/pulls/<n>/comments"
gh api "repos/$SOURCE_REPO/issues/<n>/comments"
```

Only process `fix/issue-*` PRs created by this workflow unless the user explicitly named PR numbers. Ignore praise, status, duplicates, resolved threads, and already-addressed comments.

Before spawning review work, normalize the review queue per PR:

1. Collect all actionable inline review comments and issue-level reviewer comments.
2. Group related comments by root problem, not by comment id or file. A group may include comments across several files when one underlying fix addresses them together.
3. For each group, record the root problem, related comment ids/URLs, files/lines, acceptance criteria, and any comments intentionally skipped as non-actionable.
4. Order groups deterministically: PR number, then earliest comment creation time, then first comment id.
5. Process one group at a time. Start the next group only after the previous group has reported proof, been committed/pushed if changed, and all related comments have replies or an explicit skip reason.

Spawn one review worker for the current group of the selected/scoped PR, same background rules. Do not fan out several groups from the same PR at once; sequential grouping prevents overlapping branch mutations and duplicated replies.

Make checkout/commit/push deterministic where possible:

```bash
gh pr view <n> --repo "$SOURCE_REPO" --json headRefName,headRepositoryOwner,headRepository,baseRefName
BRANCH=$(gh pr view <n> --repo "$SOURCE_REPO" --json headRefName --jq .headRefName)
git fetch origin "$BRANCH"
git checkout -B "$BRANCH" "origin/$BRANCH"
git status --short
```

Use the PR head remote when it is not `origin`; fetch and check out the exact PR head ref before editing. Refuse to continue on a dirty worktree unless the dirt is created by this review worker. Commit once per root-problem group when practical, with a conventional message scoped to the affected area. Push the checked-out branch to its PR head remote without force unless the user explicitly requested force-push.

Review worker instructions:

```text
Checkout the exact PR head branch from its remote.
Read only the grouped work item plus enough surrounding code to fix it.
Patch the minimal root-cause fix for this group.
Run relevant focused tests or a focused inspection gate.
Commit and push normally; do not force-push unless explicitly told.
Reply to every related comment in the group after the fix lands, referencing the commit and file/test proof.
For comments in the group that are not fixed, reply or report the precise skip reason.
Report root problem, related comment ids/URLs, files changed, commit, push target, replies left, skipped comments, and proof.
```

## Watch mode

Loop:

1. Fetch issues.
2. Spawn eligible issue workers.
3. Process actionable PR reviews.
4. Sleep `--interval`.
5. Stop when user says stop.

Keep cumulative summary small.
