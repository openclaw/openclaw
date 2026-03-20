---
name: gh-issues
description: "Fetch GitHub issues, spawn sub-agents to implement fixes and open PRs, then monitor and address PR review comments. Usage: /gh-issues [owner/repo] [--label bug] [--limit 5] [--milestone v1.0] [--assignee @me] [--fork user/repo] [--watch] [--interval 5] [--reviews-only] [--cron] [--dry-run] [--model glm-5] [--notify-channel -1002381931352]"
user-invocable: true
metadata:
  { "openclaw": { "requires": { "bins": ["curl", "git", "gh"] }, "primaryEnv": "GH_TOKEN" } }
---

# gh-issues — Auto-fix GitHub Issues with Parallel Sub-agents

You are an orchestrator. Follow these 6 phases exactly. Do not skip phases.

IMPORTANT — No `gh` CLI dependency. This skill uses curl + the GitHub REST API exclusively. The GH_TOKEN env var is already injected by OpenClaw. Pass it as a Bearer token in all API calls:

```
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" ...
```

---

## Phase 1 — Parse Arguments

Parse the arguments string provided after /gh-issues.

Positional:

- owner/repo — optional. This is the source repo to fetch issues from. If omitted, detect from the current git remote:
  `git remote get-url origin`
  Extract owner/repo from the URL (handles both HTTPS and SSH formats).
  - HTTPS: https://github.com/owner/repo.git → owner/repo
  - SSH: git@github.com:owner/repo.git → owner/repo
    If not in a git repo or no remote found, stop with an error asking the user to specify owner/repo.

Flags (all optional):
| Flag | Default | Description |
|------|---------|-------------|
| --label | _(none)_ | Filter by label (e.g. bug, `enhancement`) |
| --limit | 10 | Max issues to fetch per poll |
| --milestone | _(none)_ | Filter by milestone title |
| --assignee | _(none)_ | Filter by assignee (`@me` for self) |
| --state | open | Issue state: open, closed, all |
| --fork | _(none)_ | Your fork (`user/repo`) to push branches and open PRs from. Issues are fetched from the source repo; code is pushed to the fork; PRs are opened from the fork to the source repo. |
| --watch | false | Keep polling for new issues and PR reviews after each batch |
| --interval | 5 | Minutes between polls (only with `--watch`) |
| --dry-run | false | Fetch and display only — no sub-agents |
| --yes | false | Skip confirmation and auto-process all filtered issues |
| --reviews-only | false | Skip issue processing (Phases 2-5). Only run Phase 6 — check open PRs for review comments and address them. |
| --cron | false | Cron-safe mode: fetch issues and spawn sub-agents, exit without waiting for results. |
| --model | _(none)_ | Model to use for sub-agents (e.g. `glm-5`, `zai/glm-5`). If not specified, uses the agent's default model. |
| --notify-channel | _(none)_ | Telegram channel ID to send final PR summary to (e.g. -1002381931352). Only the final result with PR links is sent, not status updates. |

Store parsed values for use in subsequent phases.

Derived values:

- SOURCE_REPO = the positional owner/repo (where issues live)
- PUSH_REPO = --fork value if provided, otherwise same as SOURCE_REPO
- FORK_MODE = true if --fork was provided, false otherwise

**If `--reviews-only` is set:** Skip directly to Phase 6. Run token resolution (from Phase 2) first, then jump to Phase 6.

**If `--cron` is set:**

- Force `--yes` (skip confirmation)
- If `--reviews-only` is also set, run token resolution then jump to Phase 6 (cron review mode)
- Otherwise, proceed normally through Phases 2-5 with cron-mode behavior active

---

## Phase 2 — Fetch Issues

**Token Resolution:**
First, ensure GH_TOKEN is available. Check environment:

```
echo $GH_TOKEN
```

If empty, read from config:

```
cat ~/.openclaw/openclaw.json | jq -r '.skills.entries["gh-issues"].apiKey // empty'
```

If still empty, check `/data/.clawdbot/openclaw.json`:

```
cat /data/.clawdbot/openclaw.json | jq -r '.skills.entries["gh-issues"].apiKey // empty'
```

Export as GH_TOKEN for subsequent commands:

```
export GH_TOKEN="<token>"
```

Build and run a curl request to the GitHub Issues API via exec:

```
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/{SOURCE_REPO}/issues?per_page={limit}&state={state}&{query_params}"
```

Where {query_params} is built from:

- labels={label} if --label was provided
- milestone={milestone} if --milestone was provided (note: API expects milestone _number_, so if user provides a title, first resolve it via GET /repos/{SOURCE_REPO}/milestones and match by title)
- assignee={assignee} if --assignee was provided (if @me, first resolve your username via `GET /user`)

IMPORTANT: The GitHub Issues API also returns pull requests. Filter them out — exclude any item where pull_request key exists in the response object.

If in watch mode: Also filter out any issue numbers already in the PROCESSED_ISSUES set from previous batches.

Error handling:

- If curl returns an HTTP 401 or 403 → stop and tell the user:
  > "GitHub authentication failed. Please check your apiKey in the OpenClaw dashboard or in ~/.openclaw/openclaw.json under skills.entries.gh-issues."
- If the response is an empty array (after filtering) → report "No issues found matching filters" and stop (or loop back if in watch mode).
- If curl fails or returns any other error → report the error verbatim and stop.

Parse the JSON response. For each issue, extract: number, title, body, labels (array of label names), assignees, html_url.

---

## Phase 3 — Present & Confirm

Display a markdown table of fetched issues:

| #   | Title                         | Labels        |
| --- | ----------------------------- | ------------- |
| 42  | Fix null pointer in parser    | bug, critical |
| 37  | Add retry logic for API calls | enhancement   |

If FORK_MODE is active, also display:

> "Fork mode: branches will be pushed to {PUSH_REPO}, PRs will target `{SOURCE_REPO}`"

If `--dry-run` is active:

- Display the table and stop. Do not proceed to Phase 4.

If `--yes` is active:

- Display the table for visibility
- Auto-process ALL listed issues without asking for confirmation
- Proceed directly to Phase 4

Otherwise:
Ask the user to confirm which issues to process:

- "all" — process every listed issue
- Comma-separated numbers (e.g. `42, 37`) — process only those
- "cancel" — abort entirely

Wait for user response before proceeding.

Watch mode note: On the first poll, always confirm with the user (unless --yes is set). On subsequent polls, auto-process all new issues without re-confirming (the user already opted in). Still display the table so they can see what's being processed.

---

## Phase 4 — Pre-flight Checks

Run these checks sequentially via exec:

1. **Dirty working tree check:**

   ```
   git status --porcelain
   ```

   If output is non-empty, warn the user:

   > "Working tree has uncommitted changes. Sub-agents will create branches from HEAD — uncommitted changes will NOT be included. Continue?"
   > Wait for confirmation. If declined, stop.

2. **Record base branch:**

   ```
   git rev-parse --abbrev-ref HEAD
   ```

   Store as BASE_BRANCH.

3. **Verify remote access:**
   If FORK_MODE:
   - Verify the fork remote exists. Check if a git remote named `fork` exists:
     ```
     git remote get-url fork
     ```
     If it doesn't exist, add it:
     ```
     git remote add fork https://x-access-token:$GH_TOKEN@github.com/{PUSH_REPO}.git
     ```
   - Also verify origin (the source repo) is reachable:
     ```
     git ls-remote --exit-code origin HEAD
     ```

   If not FORK_MODE:

   ```
   git ls-remote --exit-code origin HEAD
   ```

   If this fails, stop with: "Cannot reach remote origin. Check your network and git config."

4. **Verify GH_TOKEN validity:**

   ```
   curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user
   ```

   If HTTP status is not 200, stop with:

   > "GitHub authentication failed. Please check your apiKey in the OpenClaw dashboard or in ~/.openclaw/openclaw.json under skills.entries.gh-issues."

5. **Check for existing PRs:**
   For each confirmed issue number N, run:

   ```
   curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/{SOURCE_REPO}/pulls?head={PUSH_REPO_OWNER}:fix/issue-{N}&state=open&per_page=1"
   ```

   (Where PUSH_REPO_OWNER is the owner portion of `PUSH_REPO`)
   If the response array is non-empty, remove that issue from the processing list and report:

   > "Skipping #{N} — PR already exists: {html_url}"

   If all issues are skipped, report and stop (or loop back if in watch mode).

6. **Check for in-progress branches (no PR yet = sub-agent still working):**
   For each remaining issue number N (not already skipped by the PR check above), check if a `fix/issue-{N}` branch exists on the **push repo** (which may be a fork, not origin):

   ```
   curl -s -o /dev/null -w "%{http_code}" \
     -H "Authorization: Bearer $GH_TOKEN" \
     "https://api.github.com/repos/{PUSH_REPO}/branches/fix/issue-{N}"
   ```

   If HTTP 200 → the branch exists on the push repo but no open PR was found for it in step 5. Skip that issue:

   > "Skipping #{N} — branch fix/issue-{N} exists on {PUSH_REPO}, fix likely in progress"

   This check uses the GitHub API instead of `git ls-remote` so it works correctly in fork mode (where branches are pushed to the fork, not origin).

   If all issues are skipped after this check, report and stop (or loop back if in watch mode).

7. **Check claim-based in-progress tracking:**
   This prevents duplicate processing when a sub-agent from a previous cron run is still working but hasn't pushed a branch or opened a PR yet.

   Read the claims file (create empty `{}` if missing):

   ```
   CLAIMS_FILE="/data/.clawdbot/gh-issues-claims.json"
   if [ ! -f "$CLAIMS_FILE" ]; then
     mkdir -p /data/.clawdbot
     echo '{}' > "$CLAIMS_FILE"
   fi
   ```

   Parse the claims file. For each entry, check if the claim timestamp is older than 2 hours. If so, remove it (expired — the sub-agent likely finished or failed silently). Write back the cleaned file:

   ```
   CLAIMS=$(cat "$CLAIMS_FILE")
   CUTOFF=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-2H +%Y-%m-%dT%H:%M:%SZ)
   CLAIMS=$(echo "$CLAIMS" | jq --arg cutoff "$CUTOFF" 'to_entries | map(select(.value > $cutoff)) | from_entries')
   echo "$CLAIMS" > "$CLAIMS_FILE"
   ```

   For each remaining issue number N (not already skipped by steps 5 or 6), check if `{SOURCE_REPO}#{N}` exists as a key in the claims file.

   If claimed and not expired → skip:

   > "Skipping #{N} — sub-agent claimed this issue {minutes}m ago, still within timeout window"

   Where `{minutes}` is calculated from the claim timestamp to now.

   If all issues are skipped after this check, report and stop (or loop back if in watch mode).

---

## Phase 5 — Spawn Sub-agents (Parallel)

**Cron mode (`--cron` is active):**

- **Sequential cursor tracking:** Use a cursor file to track which issue to process next:

  ```
  CURSOR_FILE="/data/.clawdbot/gh-issues-cursor-{SOURCE_REPO_SLUG}.json"
  # SOURCE_REPO_SLUG = owner-repo with slashes replaced by hyphens (e.g., openclaw-openclaw)
  ```

  Read the cursor file (create if missing):

  ```
  if [ ! -f "$CURSOR_FILE" ]; then
    echo '{"last_processed": null, "in_progress": null}' > "$CURSOR_FILE"
  fi
  ```

  - `last_processed`: issue number of the last completed issue (or null if none)
  - `in_progress`: issue number currently being processed (or null)

- **Select next issue:** Filter the fetched issues list to find the first issue where:
  - Issue number > last_processed (if last_processed is set)
  - AND issue is not in the claims file (not already in progress)
  - AND no PR exists for the issue (checked in Phase 4 step 5)
  - AND no branch exists on the push repo (checked in Phase 4 step 6)
- If no eligible issue is found after the last_processed cursor, wrap around to the beginning (start from the oldest eligible issue).

- If an eligible issue is found:
  1. Mark it as in_progress in the cursor file
  2. Spawn a single sub-agent for that one issue with `cleanup: "keep"` and `runTimeoutSeconds: 3600`
  3. If `--model` was provided, include `model: "{MODEL}"` in the spawn config
  4. If `--notify-channel` was provided, include the channel in the task so the sub-agent can notify
  5. Do NOT await the sub-agent result — fire and forget
  6. **Write claim:** After spawning, read the claims file, add `{SOURCE_REPO}#{N}` with the current ISO timestamp, and write it back
  7. Immediately report: "Spawned fix agent for #{N} — will create PR when complete"
  8. Exit the skill. Do not proceed to Results Collection or Phase 6.

- If no eligible issue is found (all issues either have PRs, have branches, or are in progress), report "No eligible issues to process — all issues have PRs/branches or are in progress" and exit.

**Normal mode (`--cron` is NOT active):**
For each confirmed issue, spawn a sub-agent using sessions_spawn. Launch up to 8 concurrently (matching `subagents.maxConcurrent: 8`). If more than 8 issues, batch them — launch the next agent as each completes.

**Write claims:** After spawning each sub-agent, read the claims file, add `{SOURCE_REPO}#{N}` with the current ISO timestamp, and write it back (same procedure as cron mode above). This covers interactive usage where watch mode might overlap with cron runs.

### Sub-agent Task Prompt

For each issue, construct the prompt from `references/fix-subagent-prompt.md` and pass it to `sessions_spawn`. Read that file when building the task.

Variables to inject into the template:

- {SOURCE_REPO} — upstream repo where the issue lives
- {PUSH_REPO} — repo to push branches to (same as SOURCE_REPO unless fork mode)
- {FORK_MODE} — true/false
- {PUSH_REMOTE} — `fork` if FORK_MODE, otherwise `origin`
- {number}, {title}, {url}, {labels}, {body} — from the issue
- {BASE_BRANCH} — from Phase 4
- {notify_channel} — Telegram channel ID for notifications (empty if not set)

When constructing the task, replace all template variables including `{notify_channel}` with actual values.

### Spawn configuration per sub-agent:

- runTimeoutSeconds: 3600 (60 minutes)
- cleanup: "keep" (preserve transcripts for review)
- If `--model` was provided, include `model: "{MODEL}"` in the spawn config

### Timeout Handling

If a sub-agent exceeds 60 minutes, record it as:

> "#{N} — Timed out (issue may be too complex for auto-fix)"

---

## Results Collection

**If `--cron` is active:** Skip this section entirely — the orchestrator already exited after spawning in Phase 5.

After ALL sub-agents complete (or timeout), collect their results. Store the list of successfully opened PRs in `OPEN_PRS` (PR number, branch name, issue number, PR URL) for use in Phase 6.

Format the results summary using `references/reporting-and-watch.md`.

End with a one-line summary:

> "Processed {N} issues: {success} PRs opened, {failed} failed, {skipped} skipped."

**Send notification to channel (if --notify-channel is set):**
If `--notify-channel` was provided, use the notification template in `references/reporting-and-watch.md`.

Then proceed to Phase 6.

---

## Phase 6 — PR Review Handler

This phase monitors open PRs (created by this skill or pre-existing `fix/issue-*` PRs) for review comments and spawns sub-agents to address them.

**When this phase runs:**

- After Results Collection (Phases 2-5 completed) — checks PRs that were just opened
- When `--reviews-only` flag is set — skips Phases 2-5 entirely, runs only this phase
- In watch mode — runs every poll cycle after checking for new issues

**Cron review mode (`--cron --reviews-only`):**
When both `--cron` and `--reviews-only` are set:

1. Run token resolution (Phase 2 token section)
2. Discover open `fix/issue-*` PRs (Step 6.1)
3. Fetch review comments (Step 6.2)
4. **Analyze comment content for actionability** (Step 6.3)
5. If actionable comments are found, spawn ONE review-fix sub-agent for the first PR with unaddressed comments — fire-and-forget (do NOT await result)
   - Use `cleanup: "keep"` and `runTimeoutSeconds: 3600`
   - If `--model` was provided, include `model: "{MODEL}"` in the spawn config
6. Report: "Spawned review handler for PR #{N} — will push fixes when complete"
7. Exit the skill immediately. Do not proceed to Step 6.5 (Review Results).

If no actionable comments found, report "No actionable review comments found" and exit.

**Normal mode (non-cron) continues below:**

### Step 6.1 — Discover PRs to Monitor

Collect PRs to check for review comments:

**If coming from Phase 5:** Use the `OPEN_PRS` list from Results Collection.

**If `--reviews-only` or subsequent watch cycle:** Fetch all open PRs with `fix/issue-` branch pattern:

```
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/{SOURCE_REPO}/pulls?state=open&per_page=100"
```

Filter to only PRs where `head.ref` starts with `fix/issue-`.

For each PR, extract: `number` (PR number), `head.ref` (branch name), `html_url`, `title`, `body`.

If no PRs found, report "No open fix/ PRs to monitor" and stop (or loop back if in watch mode).

### Step 6.2 — Fetch All Review Sources

Use the review-source fetch instructions in `references/review-handler.md`. Read that file before collecting review input for a PR so all review sources are checked consistently.

### Step 6.3 — Analyze Comments for Actionability

Use the actionability rules in `references/review-handler.md`. Read that file before filtering comments so bot comments, approvals, embedded reviews, and explicit change requests are handled consistently.

If no actionable comments found across any PR, report "No actionable review comments found" and stop (or loop back if in watch mode).

### Step 6.4 — Present Review Comments

Display a table of PRs with pending actionable comments:

```
| PR | Branch | Actionable Comments | Sources |
|----|--------|---------------------|---------|
| #99 | fix/issue-42 | 2 comments | @reviewer1, greptile |
| #101 | fix/issue-37 | 1 comment | @reviewer2 |
```

If `--yes` is NOT set and this is not a subsequent watch poll: ask the user to confirm which PRs to address ("all", comma-separated PR numbers, or "skip").

### Step 6.5 — Spawn Review Fix Sub-agents (Parallel)

For each PR with actionable comments, spawn a sub-agent. Launch up to 8 concurrently.

Use the exact review-fix prompt in `references/review-handler.md`. Read that file when constructing the task so the reply behavior and GitHub API usage stay unchanged.

**Spawn configuration per sub-agent:**

- runTimeoutSeconds: 3600 (60 minutes)
- cleanup: "keep" (preserve transcripts for review)
- If `--model` was provided, include `model: "{MODEL}"` in the spawn config

### Step 6.6 — Review Results

After all review sub-agents complete, format the summary using `references/reporting-and-watch.md`.

Add comment IDs from this batch to `ADDRESSED_COMMENTS` set to prevent re-processing.

---

## Watch Mode (if --watch is active)

After presenting results from the current batch:

1. Add all issue numbers from this batch to the running set PROCESSED_ISSUES.
2. Add all addressed comment IDs to ADDRESSED_COMMENTS.
3. Tell the user:
   > "Next poll in {interval} minutes... (say 'stop' to end watch mode)"
4. Sleep for {interval} minutes.
5. Go back to **Phase 2 — Fetch Issues**. The fetch will automatically filter out:
   - Issues already in PROCESSED_ISSUES
   - Issues that have existing fix/issue-{N} PRs (caught in Phase 4 pre-flight)
6. After Phases 2-5 (or if no new issues), run **Phase 6** to check for new review comments on ALL tracked PRs (both newly created and previously opened).
7. If no new issues AND no new actionable review comments → report "No new activity. Polling again in {interval} minutes..." and loop back to step 4.
8. The user can say "stop" at any time to exit watch mode. When stopping, present a final cumulative summary of ALL batches — issues processed AND review comments addressed.

For the watch-loop retained state and context hygiene, follow `references/reporting-and-watch.md`.
