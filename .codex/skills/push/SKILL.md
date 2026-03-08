---
name: push
description: "Sync current branch with local/fork state, push safely to fork origin, and create/update a draft PR to openclaw/openclaw main. Includes PR template usage, branch-aware title generation, prompt capture sanitization, and merge-based updates that preserve human PR edits."
user-invocable: true
metadata: { "openclaw": { "requires": { "bins": ["git", "gh"] } } }
---

# push

Use this skill when the user asks to push the current branch from a fork and open a draft PR against the original `openclaw/openclaw` repository.

## Guardrails

- Never force-push.
- Never switch branches unless the user explicitly asks.
- Keep all PR body content in files/heredocs. Do not use inline `gh ... -b "..."` when markdown contains backticks or shell characters.
- Always target upstream base branch `openclaw/openclaw:main`.
- For existing PRs, merge updates without clobbering human edits from github.com.

## Workflow

### 1. Preflight and detect repos

```bash
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" = "main" ]; then
  echo "Refusing to open PR from main; create/use a feature branch."
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty; commit/stash first."
  exit 1
fi

fork_repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
fork_owner="$(gh repo view --json owner --jq '.owner.login')"
upstream_repo="openclaw/openclaw"

if git remote get-url upstream >/dev/null 2>&1; then
  current_upstream="$(git remote get-url upstream | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
  if [ "$current_upstream" != "$upstream_repo" ]; then
    echo "upstream remote points to '$current_upstream' but expected '$upstream_repo'."
    echo "Update upstream first: git remote set-url upstream https://github.com/${upstream_repo}.git"
    exit 1
  fi
else
  git remote add upstream "https://github.com/${upstream_repo}.git"
fi
```

### 2. Persist the original user prompt and follow-ups (exclude expanded skills)

Write only user-authored prompts in chronological order.

- Keep the original user prompt and each follow-up prompt verbatim.
- If a prompt contains skill invocation output, keep only the invocation/user text (for example `$push`).
- Exclude auto-expanded skill payload blocks like `<skill> ... </skill>` from `.codex/original-user-prompt.txt`.

Use single-quoted heredocs so shell interpolation cannot alter content.

```bash
mkdir -p .codex
cat > .codex/original-user-prompt.txt <<'EOF'
<PASTE THE USER PROMPT VERBATIM HERE>
EOF
```

For each follow-up user prompt in the same request thread, append:

```bash
cat >> .codex/original-user-prompt.txt <<'EOF'

<PASTE FOLLOW-UP USER PROMPT VERBATIM HERE>
EOF
```

If your captured text accidentally includes expanded skill blocks, sanitize before PR creation:

```bash
awk '
BEGIN { in_skill=0 }
/^<skill>$/ { in_skill=1; next }
/^<\/skill>$/ { in_skill=0; next }
!in_skill { print }
' .codex/original-user-prompt.txt > .codex/original-user-prompt.filtered.txt
mv .codex/original-user-prompt.filtered.txt .codex/original-user-prompt.txt
```

Ensure root `.gitignore` contains this exact line:

```text
/.codex/original-user-prompt.txt
```

### 3. Sync local branch with fork and upstream

Fetch latest refs:

```bash
git fetch origin main "$branch" 2>/dev/null || git fetch origin main
git fetch upstream main
```

Rebase local branch on top of your fork branch (if it exists):

```bash
if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git pull --rebase origin "$branch"
fi
```

Then rebase onto upstream `main`:

```bash
git rebase upstream/main
```

If conflicts occur:

- Resolve files manually.
- Stage resolved files with `git add <file...>`.
- Continue rebase with `git rebase --continue`.
- Repeat until conflict markers are gone and rebase completes.

### 4. Push current branch safely to fork origin

```bash
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git push origin "$branch"
else
  git push -u origin "$branch"
fi
```

If push is rejected because remote moved:

```bash
git pull --rebase origin "$branch"
# resolve conflicts if prompted, then:
git push origin "$branch"
```

### 5. Build PR title/body from template (if present)

Set title from branch-only commits unless the user specifies a title:

- Include commits reachable from `HEAD`.
- Exclude commits already in `origin/main` or `upstream/main`.
- Use the first remaining commit subject as the default title.

```bash
commit_subjects="$(git log --format=%s --reverse --first-parent HEAD --not origin/main upstream/main | sed '/^[[:space:]]*$/d')"

# Fallback: if the exclusion filter yields nothing, use commits since fork-point from origin/main.
if [ -z "$commit_subjects" ]; then
  fork_point="$(git merge-base --fork-point origin/main HEAD 2>/dev/null || git merge-base origin/main HEAD)"
  commit_subjects="$(git log --format=%s --reverse --first-parent "${fork_point}..HEAD" | sed '/^[[:space:]]*$/d')"
fi

commit_count="$(printf '%s\n' "$commit_subjects" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"

if [ "$commit_count" -eq 0 ]; then
  title="chore: update branch"
else
  # Prefer a clean, representative title over concatenating many commit subjects.
  title="$(printf '%s\n' "$commit_subjects" | head -n1)"
fi

# Keep title within GitHub limits.
if [ "${#title}" -gt 240 ]; then
  title="$(printf '%s' "$title" | cut -c1-237)..."
fi

body_file="$(mktemp -t pr-body.XXXXXX.md)"
```

If `.github/pull_request_template.md` exists, use its structure and fill it with real content from this branch. Do not leave placeholders empty.

```bash
if [ -f .github/pull_request_template.md ]; then
  cp .github/pull_request_template.md "$body_file"
else
  cat > "$body_file" <<'EOF'
## Summary
- What changed
- Why it changed

## Verification
- Commands/tests run and outcome
EOF
fi
```

### 6. Append original prompts as collapsible section at bottom

Append this block to the PR body file:

```````bash
{
  printf '\n\n<details>\n<summary>Original user prompts (including follow-ups)</summary>\n\n'
  printf '``````text\n'
  cat .codex/original-user-prompt.txt
  printf '\n``````\n\n</details>\n'
} >> "$body_file"
```````

### 7. Create or update a draft PR to upstream with gh

Set cross-repo head:

```bash
head_ref="${fork_owner}:${branch}"
```

Create or update PR in the upstream repo. For existing PRs:

- Body is merged via a managed auto block (`<!-- push:auto:start --> ... <!-- push:auto:end -->`).
- Human text outside the managed block is preserved.
- Title updates only when it still matches the previous auto-generated title.
- Use `PUSH_FORCE_TITLE_UPDATE=1` to override a human-edited title.

```bash
pr_url="$(gh pr list --repo "$upstream_repo" --head "$head_ref" --base main --state open --json url --jq '.[0].url')"
auto_title_hash="$(printf '%s' "$title" | shasum -a 256 | awk '{print $1}')"
force_title_update="${PUSH_FORCE_TITLE_UPDATE:-0}"

if [ -n "$pr_url" ] && [ "$pr_url" != "null" ]; then
  current_title="$(gh pr view "$pr_url" --repo "$upstream_repo" --json title --jq '.title')"
  existing_body_file="$(mktemp -t pr-existing-body.XXXXXX.md)"
  gh pr view "$pr_url" --repo "$upstream_repo" --json body --jq '.body' > "$existing_body_file"

  prev_auto_title_hash="$(sed -nE 's/^<!-- push:auto-title-sha256:([0-9a-f]{64}) -->$/\1/p' "$existing_body_file" | head -n1)"
  current_title_hash="$(printf '%s' "$current_title" | shasum -a 256 | awk '{print $1}')"

  if [ "$force_title_update" = "1" ]; then
    final_title="$title"
  elif [ -n "$prev_auto_title_hash" ] && [ "$current_title_hash" = "$prev_auto_title_hash" ]; then
    final_title="$title"
  elif [ -z "$prev_auto_title_hash" ] && [ "$current_title" = "$title" ]; then
    final_title="$title"
  else
    final_title="$current_title"
    echo "Detected human-edited PR title; keeping current title."
    echo "Set PUSH_FORCE_TITLE_UPDATE=1 to overwrite PR title."
  fi

  cleaned_body_file="$(mktemp -t pr-clean-body.XXXXXX.md)"
  awk '
  BEGIN { in_auto=0 }
  /^<!-- push:auto:start -->$/ { in_auto=1; next }
  /^<!-- push:auto:end -->$/ { in_auto=0; next }
  !in_auto && $0 !~ /^<!-- push:auto-title-sha256:[0-9a-f]{64} -->$/ { print }
  ' "$existing_body_file" > "$cleaned_body_file"

  final_body_file="$(mktemp -t pr-final-body.XXXXXX.md)"
  cat "$cleaned_body_file" > "$final_body_file"
  printf '\n\n<!-- push:auto-title-sha256:%s -->\n' "$auto_title_hash" >> "$final_body_file"
  printf '<!-- push:auto:start -->\n' >> "$final_body_file"
  cat "$body_file" >> "$final_body_file"
  printf '\n<!-- push:auto:end -->\n' >> "$final_body_file"

  gh pr edit "$pr_url" --repo "$upstream_repo" --title "$final_title" --body-file "$final_body_file"
else
  final_body_file="$(mktemp -t pr-final-body.XXXXXX.md)"
  printf '<!-- push:auto-title-sha256:%s -->\n' "$auto_title_hash" > "$final_body_file"
  printf '<!-- push:auto:start -->\n' >> "$final_body_file"
  cat "$body_file" >> "$final_body_file"
  printf '\n<!-- push:auto:end -->\n' >> "$final_body_file"

  gh pr create --repo "$upstream_repo" --base main --head "$head_ref" --title "$title" --body-file "$final_body_file" --draft
  pr_url="$(gh pr list --repo "$upstream_repo" --head "$head_ref" --base main --state open --json url --jq '.[0].url')"
fi

echo "Fork repo: $fork_repo"
echo "Upstream repo: $upstream_repo"
echo "PR: $pr_url"
```

## Output Checklist

- Local branch synced with `origin/<branch>` and `upstream/main`.
- Branch pushed to fork `origin/<branch>` without force.
- Draft PR exists on `openclaw/openclaw` with base `main`.
- PR title represents branch-only commits (excluding commits already in `origin/main` and `upstream/main`).
- PR body derived from `.github/pull_request_template.md` when present.
- Existing PR description updates only the managed auto block; human text outside it is preserved.
- Existing PR title auto-updates only when still auto-managed; human-edited titles are preserved unless `PUSH_FORCE_TITLE_UPDATE=1`.
- Collapsible "Original user prompts (including follow-ups)" section appended at the bottom using `.codex/original-user-prompt.txt`.
