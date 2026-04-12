---
name: openclaw-secret-scanning-maintainer
description: Maintainer-only workflow for handling GitHub Secret Scanning alerts on OpenClaw. Use when Codex needs to triage, redact, clean up, and resolve secret leakage found in issue comments, issue bodies, PR comments, or other GitHub content.
---

# OpenClaw Secret Scanning Maintainer

**Maintainer-only.** This skill requires repo admin / maintainer permissions to edit or delete other users' comments and resolve secret scanning alerts.

Use this skill when processing alerts from `https://github.com/openclaw/openclaw/security/secret-scanning`.

**Language rule:** All skill content, notification comments, and replacement comments MUST be written in English.

## Overall Flow

Supports processing a single alert or multiple alerts. For multiple alerts, process them in ascending order by number.

For each alert:

1. **Identify** — fetch alert details + location + content + edit history
2. **Redact** — edit the content to mask all secrets
3. **Purge history** — remove old revisions that contain plaintext secrets
4. **Notify** — @ mention the original author with redacted info and rotation instructions
5. **Resolve** — close the alert as `revoked`
6. **Summary** — print a result summary with all relevant links

## Step 1: Identify the Alert

```bash
# Fetch alert details
gh api repos/openclaw/openclaw/secret-scanning/alerts/<NUMBER>

# Fetch leak locations
gh api repos/openclaw/openclaw/secret-scanning/alerts/<NUMBER>/locations
```

Location `type` determines the processing branch:

| type                | Meaning               | Branch                |
| ------------------- | --------------------- | --------------------- |
| `issue_comment`     | Issue / PR comment    | → Comment flow        |
| `issue_body`        | Issue body            | → Issue Body flow     |
| `pull_request_body` | PR body               | → PR Body flow        |
| `commit`            | Code commit           | → Commit flow         |
| _any other type_    | Unknown / unsupported | → **Skip and report** |

**If a location type is not listed in the table above, do NOT attempt to process it.** Skip the alert, note it in the summary, and remind the user that this skill needs to be updated to handle the new type.

## Step 2: Fetch Content and Edit History

### For issue_comment

```bash
# REST: fetch current comment content
gh api repos/openclaw/openclaw/issues/comments/<COMMENT_ID>

# GraphQL: fetch node_id and edit history
# node_id is in the REST response "node_id" field
gh api graphql -f query='
{
  node(id: "<NODE_ID>") {
    ... on IssueComment {
      body
      userContentEdits(first: 10) {
        totalCount
        nodes { id createdAt diff editor { login } }
      }
    }
  }
}'
```

### For issue_body

```bash
# REST: fetch current issue content
gh api repos/openclaw/openclaw/issues/<NUMBER>

# GraphQL: fetch issue body edit history
gh api graphql -f query='
{
  repository(owner: "openclaw", name: "openclaw") {
    issue(number: <NUMBER>) {
      body
      bodyText
      id
      userContentEdits(first: 10) {
        totalCount
        nodes { id createdAt diff editor { login } }
      }
    }
  }
}'
```

### For pull_request_body

```bash
# REST: fetch current PR content
gh api repos/openclaw/openclaw/pulls/<NUMBER>

# GraphQL: fetch PR body edit history
# node_id is in the REST response "node_id" field
gh api graphql -f query='
{
  node(id: "<NODE_ID>") {
    ... on PullRequest {
      body
      userContentEdits(first: 10) {
        totalCount
        nodes { id createdAt diff editor { login } }
      }
    }
  }
}'
```

### For commit

No edit history to fetch (commits have no edit history). Confirm the following:

```bash
# Check if the commit's PR is merged
gh api repos/openclaw/openclaw/pulls/<PR_NUMBER> | jq '{merged, state, head_ref}'

# Check if the file on main still contains the secret
gh api repos/openclaw/openclaw/contents/<FILE_PATH> | jq -r '.content' | base64 -d
```

## Step 3: Redact Secrets

### Redaction format

All secrets MUST be replaced with this format:

```
[REDACTED <secret_type>]
```

Do NOT include any portion of the actual secret value in the redaction marker. No prefix, no suffix, no character count. Even a few characters can help an attacker confirm or narrow down the full value.

Examples:

- `[REDACTED discord_bot_token]`
- `[REDACTED feishu_app_secret]`
- `[REDACTED github_pat]`
- `[REDACTED google_oauth_client_id]`

One comment/body may contain **multiple different secrets**. Scan the entire content and redact ALL of them.

### For issue_comment

Always use a temp file with heredoc to avoid shell quoting issues:

```bash
cat > /tmp/redacted_comment.md <<'BODY'
<redacted content>
BODY
gh api repos/openclaw/openclaw/issues/comments/<COMMENT_ID> \
  -X PATCH -F body=@/tmp/redacted_comment.md
```

### For issue_body

Always use a temp file with heredoc to avoid shell quoting issues:

```bash
cat > /tmp/redacted_issue.md <<'BODY'
<redacted content>
BODY
gh api repos/openclaw/openclaw/issues/<NUMBER> \
  -X PATCH -F body=@/tmp/redacted_issue.md
```

### For pull_request_body

For long body content, save to a temp file first and upload with `-F body=@file`:

```bash
# Save original body
gh api repos/openclaw/openclaw/pulls/<NUMBER> | jq -r '.body' > /tmp/pr_body.md

# Edit to redact (manual or sed/editor)
# ...

# Update PR body
gh api repos/openclaw/openclaw/pulls/<NUMBER> \
  -X PATCH -F body=@/tmp/pr_body.md
```

## Step 4: Purge Edit History

> **Critical:** GitHub has removed the `deleteUserContentEdit` mutation. There is NO API to delete individual edit revisions.

### issue_comment — Delete and Recreate

This is the only way to fully purge edit history from comments.

```bash
# 1. Delete the original comment (including all edit history)
gh api repos/openclaw/openclaw/issues/comments/<COMMENT_ID> -X DELETE

# 2. Recreate a redacted version
gh api repos/openclaw/openclaw/issues/<ISSUE_NUMBER>/comments \
  -X POST -f body='> **Note from maintainer (@<YOUR_LOGIN>):** The original comment by @<AUTHOR> has been removed due to secret leakage. Below is the redacted version of the original content.

---

<redacted original content>'
```

### issue_body / pull_request_body — Cannot Fully Purge

Edit history for issue body and PR body **cannot be cleared via API**, because:

- Cannot delete and recreate an issue/PR (would lose all comments, labels, reviews, PR associations)
- `deleteUserContentEdit` mutation has been removed by GitHub

**Important limitation:** Editing a body automatically creates a new edit history revision. GitHub stores the **pre-edit original content** (containing plaintext secrets) in that revision. Anyone can view it by clicking the "edited" button. This applies even if the original body was never edited before.

**What to do:**

1. Edit to redact the body (Step 3)
2. **Only output the warning to the maintainer in terminal** (never in public comments or resolution comments):

```
⚠️ Issue/PR body edit history still contains plaintext secrets.
GitHub API cannot clear this history. To fully purge, contact GitHub Support:
https://support.github.com/contact
Request a purge of issue/PR #{NUMBER} userContentEdits.
```

> **CRITICAL:** Do NOT mention edit history or the "edited" button in any public comment, notification, or resolution_comment. Revealing that plaintext secrets exist in edit history directs attackers to them. This information is for the maintainer only.

### commit — Context-dependent handling

| Scenario                                | Action                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| PR not merged, commit on fork branch    | Cannot clean directly (not in this repo). Notify author to delete branch or force-push              |
| PR merged, secret in main branch        | Requires BFG / git filter-repo to clean history (out of scope for this skill, alert the maintainer) |
| File deleted/modified in a later commit | Still notify — old commits remain accessible                                                        |

Include commit info only in the terminal output for the maintainer. In public notification comments, simply say the secret was found in code and the author should rotate — do not list specific commit SHAs or file paths that contain plaintext secrets.

**Terminal-only (maintainer):**

```
⚠️ The following commits still contain plaintext secrets:
- <commit_sha_short>: <file_path>
If the PR is not merged, consider deleting the branch or force-pushing a cleaned version.
```

## Step 5: Notify the Author

Post a notification comment on the same issue/PR. **All comments MUST be in English.**

> **Security:** Do NOT include any portion of the secret value or the alert URL in public comments. The alert URL is only accessible to repo admins and reveals internal tracking info. Only reference the secret by its type name.

Use a temp file with heredoc to avoid shell quoting issues:

```bash
cat > /tmp/notify_comment.md <<'BODY'
@<AUTHOR> :warning: **Security Notice: Secret Leakage Detected**

GitHub Secret Scanning detected the following exposed secret types in your content:

1. **<Secret Type Display Name>**

The affected content has been redacted.

**Please rotate these credentials immediately.**

These secrets were publicly exposed and should be considered compromised.
BODY
gh api repos/openclaw/openclaw/issues/<ISSUE_NUMBER>/comments \
  -X POST -F body=@/tmp/notify_comment.md
```

Adjust the rotation guidance based on secret type when possible (e.g., link to Discord developer portal for Discord tokens).

## Step 6: Resolve the Alert

Close the alert with `revoked`. GitHub suggests confirming the secret has been rotated before revoking, but as maintainers we cannot control whether users rotate — our responsibility is to redact + notify. Once those steps are done, the alert can be closed. The `revoked` resolution means "this secret should be considered leaked/revoked", not "I have confirmed it was revoked".

```bash
gh api repos/openclaw/openclaw/secret-scanning/alerts/<NUMBER> \
  -X PATCH -f state=resolved -f resolution=revoked \
  -f resolution_comment="Content redacted and author notified to rotate credentials."
```

Available resolution values:

| Value            | When to use                                                   |
| ---------------- | ------------------------------------------------------------- |
| `revoked`        | Secret leaked, should be considered invalidated (**default**) |
| `false_positive` | Not a real secret, false positive                             |
| `wont_fix`       | Acknowledged but will not address (rarely used)               |
| `used_in_tests`  | Test-only fake secret (rarely used)                           |

## Batch Processing

When processing multiple alerts:

```bash
# List all open alerts
gh api repos/openclaw/openclaw/secret-scanning/alerts \
  --paginate -q '.[] | select(.state=="open") | "\(.number)\t\(.secret_type_display_name)\t\(.first_location_detected.html_url)"'
```

Process each alert individually following the flow above. **Always confirm with the user before batch-deleting comments.**

## Summary

After processing each alert (or all alerts in a batch), print a result summary.

**All links MUST be printed as full URLs** (not markdown `[text](url)` syntax), so they are clickable in terminal output.

Format:

```
## Secret Scanning Results

| Alert | Type | Location | Actions | Edit History |
|-------|------|----------|---------|--------------|
| #72 https://github.com/openclaw/openclaw/security/secret-scanning/72 | Discord Bot Token | Issue #63101 comment https://github.com/openclaw/openclaw/issues/63101#issuecomment-xxx | Redacted+Deleted+Recreated+Notified | Cleared |
| #56 https://github.com/openclaw/openclaw/security/secret-scanning/56 | Google OAuth Client ID | PR #3077 body https://github.com/openclaw/openclaw/pull/3077 | Redacted+Notified | ⚠️ History remains |
```

Each row MUST include:

- Alert number and full URL: `#<N> https://github.com/openclaw/openclaw/security/secret-scanning/<N>`
- Leak location with full URL: e.g., `Issue #<N> https://github.com/openclaw/openclaw/issues/<N>` or `PR #<N> https://github.com/openclaw/openclaw/pull/<N>`
- Actions taken
- Edit history status: `Cleared`, `⚠️ History remains`, or `Skipped (unsupported type: <type>)`

For issues/PRs with ⚠️ History remains, add a follow-up section (terminal output only, never in public comments):

```
Issues requiring GitHub Support to purge edit history:
- Issue #1594 https://github.com/openclaw/openclaw/issues/1594 — Telegram Bot Token
- Issue #4155 https://github.com/openclaw/openclaw/issues/4155 — Google OAuth Client ID/Secret
Contact: https://support.github.com/contact — request purge of userContentEdits for the above issues.
```

> **CRITICAL:** Never mention edit history details, "edited" button, or specific commit SHAs containing plaintext in any public-facing content (comments, PR descriptions, resolution comments). This information must only appear in terminal output for the maintainer.

For any skipped alerts, add a note at the bottom of the summary:

```
⚠️ The following alerts were skipped because their location type is not supported by this skill.
Please update the skill to define handling for these types:
- Alert #<N>: unsupported type "<type>" — https://github.com/openclaw/openclaw/security/secret-scanning/<N>
```

## Safety Rules

- **Always read the content before editing.** Never blindly patch.
- **Preserve the original message intent.** Only redact secrets, keep all other content intact.
- **Check for multiple secrets** in a single comment/body — alerts may only flag one, but there could be more.
- **Never include any portion of a secret** in public comments, redaction markers, or terminal output. Use type-only redaction: `[REDACTED <type>]`.
- **Never include secret scanning alert URLs** in public comments — they are admin-only and leak internal info.
- **Ask for confirmation** before deleting any comment or issue.
- **One alert at a time** unless the user explicitly requests batch processing.
- **Always print the summary** after processing, with all alert/issue/PR links for verification.
- **All comments and notifications MUST be written in English.**
- **Skip unsupported location types.** If a location type is not defined in this skill (e.g., not `issue_comment`, `issue_body`, `pull_request_body`, or `commit`), do not process it. Report it in the summary and note that the skill needs to be updated.
- **Use temp files with heredoc** for all `gh api` calls that set body content. Never inline body text with `-f body='...'` — it is vulnerable to shell quoting issues and command injection via copy/paste.
- **Never print raw API response bodies to stdout.** When fetching alert details or comment content for analysis, pipe through `jq` to extract only the fields you need (e.g., `jq '{number, state, secret_type}'`). Avoid printing `.secret` or `.body` fields that contain plaintext secrets.
