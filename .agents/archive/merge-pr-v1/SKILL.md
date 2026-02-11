---
name: merge-pr
description: Merge a GitHub PR via squash after /prepare-pr. Use when asked to merge a ready PR. Do not push to main or modify code. Ensure the PR ends in MERGED state and clean up worktrees after success.
---

# Merge PR

## Overview

Merge a prepared PR via deterministic squash merge (`--match-head-commit` + explicit co-author trailer), then clean up the worktree after success.

## Inputs

- Ask for PR number or URL.
- If missing, use `.local/prep.env` from the worktree if present.
- If ambiguous, ask.

## Safety

- Use `gh pr merge --squash` as the only path to `main`.
- Do not run `git push` at all during merge.
- Do not use `gh pr merge --auto` for maintainer landings.
- Do not run gateway stop commands. Do not kill processes. Do not touch port 18792.

## Execution Rule

- Execute the workflow. Do not stop after printing the TODO checklist.
- If delegating, require the delegate to run commands and capture outputs.

## Known Footguns

- If you see "fatal: not a git repository", you are in the wrong directory. Move to the repo root and retry.
- Read `.local/review.md`, `.local/prep.md`, and `.local/prep.env` in the worktree. Do not skip.
- Always merge with `--match-head-commit "$PREP_HEAD_SHA"` to prevent racing stale or changed heads.
- Clean up `.worktrees/pr-<PR>` only after confirmed `MERGED`.

## Completion Criteria

- Ensure `gh pr merge` succeeds.
- Ensure PR state is `MERGED`, never `CLOSED`.
- Record the merge SHA.
- Leave a PR comment with merge SHA and prepared head SHA, and capture the comment URL.
- Run cleanup only after merge success.

## First: Create a TODO Checklist

Create a checklist of all merge steps, print it, then continue and execute the commands.

## Setup: Use a Worktree

Use an isolated worktree for all merge work.

```sh
repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"
gh auth status

WORKTREE_DIR=".worktrees/pr-<PR>"
cd "$WORKTREE_DIR"
```

Run all commands inside the worktree directory.

## Load Local Artifacts (Mandatory)

Expect these files from earlier steps:

- `.local/review.md` from `/review-pr`
- `.local/prep.md` from `/prepare-pr`
- `.local/prep.env` from `/prepare-pr`

```sh
ls -la .local || true

for required in .local/review.md .local/prep.md .local/prep.env; do
  if [ ! -f "$required" ]; then
    echo "Missing $required. Stop and run /review-pr then /prepare-pr."
    exit 1
  fi
done

sed -n '1,120p' .local/review.md
sed -n '1,120p' .local/prep.md
source .local/prep.env
```

## Steps

1. Identify PR meta and verify prepared SHA still matches

```sh
pr_meta_json=$(gh pr view <PR> --json number,title,state,isDraft,author,headRefName,headRefOid,baseRefName,headRepository,body)
printf '%s\n' "$pr_meta_json" | jq '{number,title,state,isDraft,author:.author.login,head:.headRefName,headSha:.headRefOid,base:.baseRefName,headRepo:.headRepository.nameWithOwner,body}'
pr_title=$(printf '%s\n' "$pr_meta_json" | jq -r .title)
pr_number=$(printf '%s\n' "$pr_meta_json" | jq -r .number)
pr_head_sha=$(printf '%s\n' "$pr_meta_json" | jq -r .headRefOid)
contrib=$(printf '%s\n' "$pr_meta_json" | jq -r .author.login)
is_draft=$(printf '%s\n' "$pr_meta_json" | jq -r .isDraft)

if [ "$is_draft" = "true" ]; then
  echo "ERROR: PR is draft. Stop and run /prepare-pr after draft is cleared."
  exit 1
fi

if [ "$pr_head_sha" != "$PREP_HEAD_SHA" ]; then
  echo "ERROR: PR head changed after /prepare-pr (expected $PREP_HEAD_SHA, got $pr_head_sha). Re-run /prepare-pr."
  exit 1
fi
```

2. Run sanity checks

Stop if any are true:

- PR is a draft.
- Required checks are failing.
- Branch is behind main.

If checks are pending, wait for completion before merging. Do not use `--auto`.
If no required checks are configured, continue.

```sh
gh pr checks <PR> --required --watch --fail-fast || true
checks_json=$(gh pr checks <PR> --required --json name,bucket,state 2>/tmp/gh-checks.err || true)
if [ -z "$checks_json" ]; then
  checks_json='[]'
fi
required_count=$(printf '%s\n' "$checks_json" | jq 'length')
if [ "$required_count" -eq 0 ]; then
  echo "No required checks configured for this PR."
fi
printf '%s\n' "$checks_json" | jq -r '.[] | "\(.bucket)\t\(.name)\t\(.state)"'

failed_required=$(printf '%s\n' "$checks_json" | jq '[.[] | select(.bucket=="fail")] | length')
pending_required=$(printf '%s\n' "$checks_json" | jq '[.[] | select(.bucket=="pending")] | length')
if [ "$failed_required" -gt 0 ]; then
  echo "Required checks are failing, run /prepare-pr."
  exit 1
fi
if [ "$pending_required" -gt 0 ]; then
  echo "Required checks are still pending, retry /merge-pr when green."
  exit 1
fi

git fetch origin main
git fetch origin pull/<PR>/head:pr-<PR> --force
git merge-base --is-ancestor origin/main pr-<PR> || (echo "PR branch is behind main, run /prepare-pr" && exit 1)
```

If anything is failing or behind, stop and say to run `/prepare-pr`.

3. Merge PR with explicit attribution metadata

```sh
reviewer=$(gh api user --jq .login)
reviewer_id=$(gh api user --jq .id)
coauthor_email=${COAUTHOR_EMAIL:-"$contrib@users.noreply.github.com"}
if [ -z "$coauthor_email" ] || [ "$coauthor_email" = "null" ]; then
  contrib_id=$(gh api users/$contrib --jq .id)
  coauthor_email="${contrib_id}+${contrib}@users.noreply.github.com"
fi

gh_email=$(gh api user --jq '.email // ""' || true)
git_email=$(git config user.email || true)
mapfile -t reviewer_email_candidates < <(
  printf '%s\n' \
    "$gh_email" \
    "$git_email" \
    "${reviewer_id}+${reviewer}@users.noreply.github.com" \
    "${reviewer}@users.noreply.github.com" | awk 'NF && !seen[$0]++'
)
[ "${#reviewer_email_candidates[@]}" -gt 0 ] || { echo "ERROR: could not resolve reviewer author email"; exit 1; }
reviewer_email="${reviewer_email_candidates[0]}"

cat > .local/merge-body.txt <<EOF
Merged via /review-pr -> /prepare-pr -> /merge-pr.

Prepared head SHA: $PREP_HEAD_SHA
Co-authored-by: $contrib <$coauthor_email>
Co-authored-by: $reviewer <$reviewer_email>
Reviewed-by: @$reviewer
EOF

run_merge() {
  local email="$1"
  local stderr_file
  stderr_file=$(mktemp)
  if gh pr merge <PR> \
    --squash \
    --delete-branch \
    --match-head-commit "$PREP_HEAD_SHA" \
    --author-email "$email" \
    --subject "$pr_title (#$pr_number)" \
    --body-file .local/merge-body.txt \
    2> >(tee "$stderr_file" >&2)
  then
    rm -f "$stderr_file"
    return 0
  fi
  merge_err=$(cat "$stderr_file")
  rm -f "$stderr_file"
  return 1
}

merge_err=""
selected_merge_author_email="$reviewer_email"
if ! run_merge "$selected_merge_author_email"; then
  if printf '%s\n' "$merge_err" | rg -qi 'author.?email|email.*associated|associated.*email|invalid.*email' && [ "${#reviewer_email_candidates[@]}" -ge 2 ]; then
    selected_merge_author_email="${reviewer_email_candidates[1]}"
    echo "Retrying once with fallback author email: $selected_merge_author_email"
    run_merge "$selected_merge_author_email" || { echo "ERROR: merge failed after fallback retry"; exit 1; }
  else
    echo "ERROR: merge failed"
    exit 1
  fi
fi
```

Retry is allowed exactly once when the error is clearly author-email validation.

4. Verify PR state and capture merge SHA

```sh
state=$(gh pr view <PR> --json state --jq .state)
if [ "$state" != "MERGED" ]; then
  echo "Merge not finalized yet (state=$state), waiting up to 15 minutes..."
  for _ in $(seq 1 90); do
    sleep 10
    state=$(gh pr view <PR> --json state --jq .state)
    if [ "$state" = "MERGED" ]; then
      break
    fi
  done
fi

if [ "$state" != "MERGED" ]; then
  echo "ERROR: PR state is $state after waiting. Leave worktree and retry /merge-pr later."
  exit 1
fi

merge_sha=$(gh pr view <PR> --json mergeCommit --jq '.mergeCommit.oid')
if [ -z "$merge_sha" ] || [ "$merge_sha" = "null" ]; then
  echo "ERROR: merge commit SHA missing."
  exit 1
fi

commit_body=$(gh api repos/:owner/:repo/commits/$merge_sha --jq .commit.message)
contrib=${contrib:-$(gh pr view <PR> --json author --jq .author.login)}
reviewer=${reviewer:-$(gh api user --jq .login)}
printf '%s\n' "$commit_body" | rg -q "^Co-authored-by: $contrib <" || { echo "ERROR: missing PR author co-author trailer"; exit 1; }
printf '%s\n' "$commit_body" | rg -q "^Co-authored-by: $reviewer <" || { echo "ERROR: missing reviewer co-author trailer"; exit 1; }

echo "merge_sha=$merge_sha"
```

5. PR comment

Use a multiline heredoc with interpolation enabled.

```sh
ok=0
comment_output=""
for _ in 1 2 3; do
  if comment_output=$(gh pr comment <PR> -F - <<EOF
Merged via squash.

- Prepared head SHA: $PREP_HEAD_SHA
- Merge commit: $merge_sha

Thanks @$contrib!
EOF
); then
    ok=1
    break
  fi
  sleep 2
done

[ "$ok" -eq 1 ] || { echo "ERROR: failed to post PR comment after retries"; exit 1; }
comment_url=$(printf '%s\n' "$comment_output" | rg -o 'https://github.com/[^ ]+/pull/[0-9]+#issuecomment-[0-9]+' -m1 || true)
[ -n "$comment_url" ] || comment_url="unresolved"
echo "comment_url=$comment_url"
```

6. Clean up worktree only on success

Run cleanup only if step 4 returned `MERGED`.

```sh
cd "$repo_root"
git worktree remove ".worktrees/pr-<PR>" --force
git branch -D temp/pr-<PR> 2>/dev/null || true
git branch -D pr-<PR> 2>/dev/null || true
git branch -D pr-<PR>-prep 2>/dev/null || true
```

## Guardrails

- Worktree only.
- Do not close PRs.
- End in MERGED state.
- Clean up only after merge success.
- Never push to main. Use `gh pr merge --squash` only.
- Do not run `git push` at all in this command.
