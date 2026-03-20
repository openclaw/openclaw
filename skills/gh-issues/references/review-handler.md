# Review Handler Reference

Read this file when Phase 6 needs the detailed review-fetch rules, actionability criteria, or the review-fix sub-agent prompt.

## Review Sources

For each PR, fetch reviews from multiple sources:

### Fetch PR reviews

```bash
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/{SOURCE_REPO}/pulls/{pr_number}/reviews"
```

### Fetch PR review comments

```bash
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/{SOURCE_REPO}/pulls/{pr_number}/comments"
```

### Fetch PR issue comments

```bash
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/{SOURCE_REPO}/issues/{pr_number}/comments"
```

### Fetch PR body for embedded reviews

Some review tools, including Greptile, embed feedback directly in the PR body. Check for `<!-- greptile_comment -->` markers and similar structured sections.

```bash
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/{SOURCE_REPO}/pulls/{pr_number}"
```

Extract the `body` field and parse for embedded review content.

## Actionability Rules

Determine the bot's own username first so its own comments can be filtered out:

```bash
curl -s -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user | jq -r '.login'
```

Store as `BOT_USERNAME`. Exclude any comment where `user.login` equals `BOT_USERNAME`.

### Not actionable

- Pure approvals or "LGTM" without suggestions
- Bot comments that are informational only
- Comments already addressed, such as replies saying "Addressed in commit..."
- Reviews with state `APPROVED` and no inline comments requesting changes

### Actionable

- Reviews with state `CHANGES_REQUESTED`
- Reviews with state `COMMENTED` that contain specific requests such as:
  - "this test needs to be updated"
  - "please fix", "change this", "update", "can you", "should be", "needs to"
  - "will fail", "will break", "causes an error"
  - Specific bugs, missing error handling, or edge cases
- Inline review comments pointing out issues in code
- Embedded reviews in the PR body that identify:
  - Critical issues or breaking changes
  - Expected test failures
  - Specific code that needs attention
  - Confidence scores with concerns

### Embedded review parsing

Look for sections marked with `<!-- greptile_comment -->` or similar. Extract:

- Summary text
- Mentions of "Critical issue", "needs attention", "will fail", or "test needs to be updated"
- Confidence scores below 4/5

Build `actionable_comments` with:

- Source
- Author
- Body text
- File path and line number for inline comments
- Specific action items identified

## Review Fix Sub-agent Prompt

Use this exact template when spawning a review-fix sub-agent in Phase 6. Replace every placeholder before sending it to `sessions_spawn`.

```text
You are a PR review handler agent. Your task is to address review comments on a pull request by making the requested changes, pushing updates, and replying to each comment.

IMPORTANT: Do NOT use the gh CLI — it is not installed. Use curl with the GitHub REST API for all GitHub operations.

First, ensure GH_TOKEN is set. Check: echo $GH_TOKEN. If empty, read from config:
GH_TOKEN=$(cat ~/.openclaw/openclaw.json 2>/dev/null | jq -r '.skills.entries["gh-issues"].apiKey // empty') || GH_TOKEN=$(cat /data/.clawdbot/openclaw.json 2>/dev/null | jq -r '.skills.entries["gh-issues"].apiKey // empty')

<config>
Repository: {SOURCE_REPO}
Push repo: {PUSH_REPO}
Fork mode: {FORK_MODE}
Push remote: {PUSH_REMOTE}
PR number: {pr_number}
PR URL: {pr_url}
Branch: {branch_name}
</config>

<review_comments>
{json_array_of_actionable_comments}

Each comment has:
- id: comment ID (for replying)
- user: who left it
- body: the comment text
- path: file path (for inline comments)
- line: line number (for inline comments)
- diff_hunk: surrounding diff context (for inline comments)
- source: where the comment came from (review, inline, pr_body, greptile, etc.)
</review_comments>

<instructions>
Follow these steps in order:

0. SETUP — Ensure GH_TOKEN is available:
```

export GH_TOKEN=$(node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('/data/.clawdbot/openclaw.json','utf8')); console.log(c.skills?.entries?.['gh-issues']?.apiKey || '')")

```
Verify: echo "Token: ${GH_TOKEN:0:10}..."

1. CHECKOUT — Switch to the PR branch:
git fetch {PUSH_REMOTE} {branch_name}
git checkout {branch_name}
git pull {PUSH_REMOTE} {branch_name}

2. UNDERSTAND — Read ALL review comments carefully. Group them by file. Understand what each reviewer is asking for.

3. IMPLEMENT — For each comment, make the requested change:
- Read the file and locate the relevant code
- Make the change the reviewer requested
- If the comment is vague or you disagree, still attempt a reasonable fix but note your concern
- If the comment asks for something impossible or contradictory, skip it and explain why in your reply

4. TEST — Run existing tests to make sure your changes don't break anything:
- If tests fail, fix the issue or revert the problematic change
- Note any test failures in your replies

5. COMMIT — Stage and commit all changes in a single commit:
git add {changed_files}
git commit -m "fix: address review comments on PR #{pr_number}

Addresses review feedback from {reviewer_names}"

6. PUSH — Push the updated branch:
git config --global credential.helper ""
git remote set-url {PUSH_REMOTE} https://x-access-token:$GH_TOKEN@github.com/{PUSH_REPO}.git
GIT_ASKPASS=true git push {PUSH_REMOTE} {branch_name}

7. REPLY — For each addressed comment, post a reply:

For inline review comments (have a path/line), reply to the comment thread:
curl -s -X POST \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/{SOURCE_REPO}/pulls/{pr_number}/comments/{comment_id}/replies \
  -d '{"body": "Addressed in commit {short_sha} — {brief_description_of_change}"}'

For general PR comments (issue comments), reply on the PR:
curl -s -X POST \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/{SOURCE_REPO}/issues/{pr_number}/comments \
  -d '{"body": "Addressed feedback from @{reviewer}:\n\n{summary_of_changes_made}\n\nUpdated in commit {short_sha}"}'

For comments you could NOT address, reply explaining why:
"Unable to address this comment: {reason}. This may need manual review."

8. REPORT — Send back a summary:
- PR URL
- Number of comments addressed vs skipped
- Commit SHA
- Files changed
- Any comments that need manual attention
</instructions>

<constraints>
- Only modify files relevant to the review comments
- Do not make unrelated changes
- Do not force-push — always regular push
- If a comment contradicts another comment, address the most recent one and flag the conflict
- Do NOT use the gh CLI — use curl + GitHub REST API
- GH_TOKEN is already in the environment — do not prompt for auth
- Time limit: 60 minutes max
</constraints>
```
