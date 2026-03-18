# gh-issues — Full Phase Instructions & Sub-agent Prompts

## Phase 1 — Parse Arguments

Parse the arguments string provided after /gh-issues.

Positional:
- `owner/repo` — optional. If omitted, detect from git remote:
  `git remote get-url origin`
  Extract owner/repo (HTTPS: `https://github.com/owner/repo.git`; SSH: `git@github.com:owner/repo.git`).
  If not in a git repo, stop with error asking user to specify.

Derived values:
- `SOURCE_REPO` = positional owner/repo (where issues live)
- `PUSH_REPO` = `--fork` value if provided, otherwise same as SOURCE_REPO
- `FORK_MODE` = true if `--fork` was provided

**If `--reviews-only` is set:** Run token resolution (Phase 2), then jump to Phase 6.
**If `--cron` is set:** Force `--yes`. If also `--reviews-only`, jump to Phase 6 after token resolution.

---

## Phase 2 — Fetch Issues

**Token Resolution:**
```bash
echo $GH_TOKEN
# If empty:
cat ~/.openclaw/openclaw.json | jq -r '.skills.entries["gh-issues"].apiKey // empty'
# If still empty:
cat /data/.clawdbot/openclaw.json | jq -r '.skills.entries["gh-issues"].apiKey // empty'
export GH_TOKEN="<token>"
```

Fetch issues:
```bash
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/{SOURCE_REPO}/issues?per_page={limit}&state={state}&{query_params}"
```
`{query_params}`: `labels=`, `milestone=` (resolve title→number via GET /milestones), `assignee=` (@me → resolve via GET /user).

**Filter out PRs** (exclude items where `pull_request` key exists).
In watch mode: also filter PROCESSED_ISSUES from previous batches.

Errors: 401/403 → auth error message. Empty array → "No issues found". Other error → report verbatim.

---

## Phase 3 — Present & Confirm

Display markdown table: `# | Title | Labels`

If FORK_MODE: show "Fork mode: branches → {PUSH_REPO}, PRs target {SOURCE_REPO}"

- `--dry-run`: Display and stop.
- `--yes`: Display and auto-process all.
- Otherwise: Ask "all", comma-separated numbers, or "cancel". Wait for response.

Watch mode: First poll always confirms (unless `--yes`). Subsequent polls auto-process.

---

## Phase 4 — Pre-flight Checks

Run sequentially:

1. **Dirty tree**: `git status --porcelain` — warn if non-empty, wait for confirmation.
2. **Base branch**: `git rev-parse --abbrev-ref HEAD` → store as `BASE_BRANCH`.
3. **Remote access**:
   - Fork mode: ensure `fork` remote exists (`git remote get-url fork`), add if missing:
     `git remote add fork https://x-access-token:$GH_TOKEN@github.com/{PUSH_REPO}.git`
   - Run `git ls-remote --exit-code origin HEAD`
4. **Token validity**: `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user` → must be 200.
5. **Existing PRs**: For each issue N:
   ```bash
   curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/{SOURCE_REPO}/pulls?head={PUSH_REPO_OWNER}:fix/issue-{N}&state=open&per_page=1"
   ```
   Non-empty → skip and report PR URL.
6. **In-progress branches**: Check `https://api.github.com/repos/{PUSH_REPO}/branches/fix/issue-{N}` → HTTP 200 = skip.
7. **Claims check**:
   ```bash
   CLAIMS_FILE="/data/.clawdbot/gh-issues-claims.json"
   # Create if missing, clean entries older than 2h, check {SOURCE_REPO}#{N} key
   ```
   If claimed and not expired → skip with age in minutes.

---

## Phase 5 — Spawn Sub-agents (Parallel)

### Cron mode

Use cursor file `/data/.clawdbot/gh-issues-cursor-{SOURCE_REPO_SLUG}.json`:
```json
{"last_processed": null, "in_progress": null}
```

Find first eligible issue: `number > last_processed`, not in claims, no PR, no branch.
If none found (wrap-around), report "No eligible issues" and exit.

1. Mark as `in_progress` in cursor file
2. Spawn one sub-agent (fire-and-forget, do NOT await)
3. Write claim to claims file
4. Report "Spawned fix agent for #{N}" and **exit**

### Normal mode

Spawn up to 8 sub-agents concurrently. Write claims after each spawn.

### Sub-agent Task Prompt Template

Replace all `{variables}` with actual values before passing to sessions_spawn:

```
You are a focused code-fix agent. Fix a single GitHub issue and open a PR.

IMPORTANT: Do NOT use the gh CLI. Use curl + GitHub REST API. GH_TOKEN is in env.

First ensure GH_TOKEN is set:
export GH_TOKEN=$(node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('/data/.clawdbot/openclaw.json','utf8')); console.log(c.skills?.entries?.['gh-issues']?.apiKey || '')")
Fallback: cat ~/.openclaw/openclaw.json | jq -r '.skills.entries["gh-issues"].apiKey // empty'
Verify: echo "Token: ${GH_TOKEN:0:10}..."

<config>
Source repo: {SOURCE_REPO}
Push repo: {PUSH_REPO}
Fork mode: {FORK_MODE}
Push remote: {PUSH_REMOTE}
Base branch: {BASE_BRANCH}
Notify channel: {notify_channel}
</config>

<issue>
Repository: {SOURCE_REPO}
Issue: #{number}
Title: {title}
URL: {url}
Labels: {labels}
Body: {body}
</issue>

Steps:
0. SETUP — Verify GH_TOKEN (above)
1. CONFIDENCE CHECK — Rate 1-10. If < 7, STOP: "Skipping #{number}: Low confidence (N/10) — [reason]"
2. UNDERSTAND — Read issue, identify what to change and where
3. BRANCH — `git checkout -b fix/issue-{number} {BASE_BRANCH}`
4. ANALYZE — grep/find relevant files, read them, identify root cause
5. IMPLEMENT — Minimal focused fix, follow existing style, no unrelated changes
6. TEST — Find and run existing test suite; if fail, one retry; if still fail, report
7. COMMIT — `git commit -m "fix: {short_description}\n\nFixes {SOURCE_REPO}#{number}"`
8. PUSH:
   git config --global credential.helper ""
   git remote set-url {PUSH_REMOTE} https://x-access-token:$GH_TOKEN@github.com/{PUSH_REPO}.git
   GIT_ASKPASS=true git push -u {PUSH_REMOTE} fix/issue-{number}
9. PR — POST to https://api.github.com/repos/{SOURCE_REPO}/pulls:
   - Fork mode: head="{PUSH_REPO_OWNER}:fix/issue-{number}"
   - Normal: head="fix/issue-{number}"
   - base="{BASE_BRANCH}", body includes "Fixes {SOURCE_REPO}#{number}"
   Extract html_url from response.
10. REPORT — PR URL, files changed, fix summary, caveats
11. NOTIFY (if {notify_channel} set) — message tool: action=send, channel=telegram, target={notify_channel}

Constraints: no force-push, no unrelated changes, no new deps without justification, 60min max.
```

**Spawn config**: `runTimeoutSeconds: 3600`, `cleanup: "keep"`, add `model` if `--model` provided.

---

## Results Collection

*(Skip if `--cron` active — orchestrator already exited.)*

After all sub-agents complete, present summary table:
`| Issue | Status | PR | Notes |`

Statuses: PR opened / Failed / Timed out / Skipped

End: "Processed {N} issues: {success} PRs opened, {failed} failed, {skipped} skipped."

If `--notify-channel`: send final summary to Telegram with PR list.

Store `OPEN_PRS` (PR number, branch, issue number, PR URL) for Phase 6.

---

## Phase 6 — PR Review Handler

**When it runs:**
- After Results Collection (normal flow)
- `--reviews-only`: skip Phases 2-5, run only this phase
- `--cron --reviews-only`: one review-fix agent fire-and-forget, then exit

### Step 6.1 — Discover PRs

From Phase 5 OPEN_PRS, or fetch:
```bash
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/{SOURCE_REPO}/pulls?state=open&per_page=100"
```
Filter: `head.ref` starts with `fix/issue-`.

### Step 6.2 — Fetch Reviews

For each PR, fetch all three sources:
- `GET /repos/{SOURCE_REPO}/pulls/{pr_number}/reviews`
- `GET /repos/{SOURCE_REPO}/pulls/{pr_number}/comments`
- `GET /repos/{SOURCE_REPO}/issues/{pr_number}/comments`
- `GET /repos/{SOURCE_REPO}/pulls/{pr_number}` → parse `body` for embedded reviews (e.g. `<!-- greptile_comment -->`)

### Step 6.3 — Actionability Filter

Resolve `BOT_USERNAME` via `GET /user`. Exclude own comments.

**NOT actionable**: pure LGTM/approvals, informational bot comments, already-addressed comments (bot replied "Addressed in commit..."), APPROVED reviews with no inline requests.

**IS actionable**: `CHANGES_REQUESTED` reviews, `COMMENTED` reviews with specific requests ("please fix", "change this", "update", "will fail", "needs to"), inline comments pointing out bugs, embedded reviews with critical issues or confidence < 4/5.

Build `actionable_comments` list: source, author, body, file path + line (inline), action items.

### Step 6.4 — Present

Table: `| PR | Branch | Actionable Comments | Sources |`

If not `--yes` and not subsequent watch poll: confirm which PRs to address.

### Step 6.5 — Spawn Review-Fix Sub-agents

```
You are a PR review handler. Address review comments, push fixes, reply to each comment.

No gh CLI. Use curl + GitHub REST API. GH_TOKEN in env.

<config>
Repo: {SOURCE_REPO} | Push repo: {PUSH_REPO}
Fork mode: {FORK_MODE} | Push remote: {PUSH_REMOTE}
PR: #{pr_number} ({pr_url}) | Branch: {branch_name}
</config>

<review_comments>
{json_array_of_actionable_comments}
(id, user, body, path, line, diff_hunk, source)
</review_comments>

Steps:
1. CHECKOUT — git fetch {PUSH_REMOTE} {branch_name} && git checkout {branch_name} && git pull
2. UNDERSTAND — Group comments by file, understand all requests
3. IMPLEMENT — Make each requested change; flag contradictions
4. TEST — Run tests; fix failures or revert problematic change
5. COMMIT — git commit -m "fix: address review comments on PR #{pr_number}"
6. PUSH — set-url with token, GIT_ASKPASS=true git push
7. REPLY — For inline comments: POST /pulls/{pr_number}/comments/{id}/replies
           For general: POST /issues/{pr_number}/comments
           Reply: "Addressed in commit {sha} — {description}"
           If skipped: "Unable to address: {reason}"
8. REPORT — PR URL, comments addressed vs skipped, commit SHA, files changed

Constraints: only modify files relevant to review comments, no force-push, 60min max.
```

**Spawn config**: `runTimeoutSeconds: 3600`, `cleanup: "keep"`, add `model` if `--model` provided.

### Step 6.6 — Review Results

Table: `| PR | Comments Addressed | Comments Skipped | Commit | Status |`

Add addressed comment IDs to `ADDRESSED_COMMENTS` to prevent re-processing.

---

## Watch Mode

After each batch:
1. Add issue numbers → `PROCESSED_ISSUES`; comment IDs → `ADDRESSED_COMMENTS`
2. "Next poll in {interval} minutes... (say 'stop' to end)"
3. Sleep {interval} minutes → back to Phase 2
4. After Phases 2-5, always run Phase 6 for ALL tracked PRs
5. No new activity → "No new activity. Polling again in {interval} minutes..."

**Context hygiene between polls** — retain only: PROCESSED_ISSUES, ADDRESSED_COMMENTS, OPEN_PRS, cumulative results, parsed args, BASE_BRANCH, SOURCE_REPO, PUSH_REPO, FORK_MODE, BOT_USERNAME. Discard issue bodies, comment bodies, sub-agent transcripts.
