#!/usr/bin/env bash
# run_codex.sh — eng-codex skill executor
# Usage: run_codex.sh <TASK> <OWNER_REPO> [TASK_ID] [COMPLEXITY]
# Env:   LINEAR_ISSUE_ID (optional)
set -euo pipefail

# ── Args ────────────────────────────────────────────────────────────────────
TASK="${1:?Usage: run_codex.sh <task> <owner/repo> [task_id] [complexity]}"
OWNER_REPO="${2:?OWNER_REPO is required (e.g. sebbyyyywebbyyy/my-app)}"
TASK_ID="${3:-$(date +%s)-$(openssl rand -hex 3)}"
COMPLEXITY="${4:-standard}"
LINEAR_ISSUE_ID="${LINEAR_ISSUE_ID:-}"

# ── Paths ────────────────────────────────────────────────────────────────────
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="/home/node/.openclaw/workspace-engineering"
REPOS_DIR="${WORKSPACE}/repos"
REPO_DIR="${REPOS_DIR}/${OWNER_REPO}"
WORKTREE="/tmp/worktrees/${TASK_ID}"
BRANCH="eng-codex/${TASK_ID}"
LOG_FILE="${WORKSPACE}/.eng/logs/${TASK_ID}.jsonl"
REVIEWER="${SKILL_DIR}/../eng-reviewer/review.py"

# ── Helpers ──────────────────────────────────────────────────────────────────
log() {
  local level="$1"; shift
  local msg="$*"
  echo "[eng-codex/${TASK_ID}] ${level}: ${msg}"
  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"level\":\"${level}\",\"msg\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$msg")}" >> "${LOG_FILE}"
}

cleanup_worktree() {
  if [[ -d "$WORKTREE" ]]; then
    git -C "${REPO_DIR}" worktree remove --force "${WORKTREE}" 2>/dev/null || true
    git -C "${REPO_DIR}" branch -D "${BRANCH}" 2>/dev/null || true
    log "INFO" "Worktree cleaned up"
  fi
}

fail() {
  log "ERROR" "$*"
  echo "[eng-codex] FAILED: $*" >&2
  exit 1
}

discord_notify() {
  local msg="$1"
  local channel="${ENG_DISCORD_CHANNEL:-1472630681870925998}"
  [[ -z "$channel" ]] && return 0
  openclaw message send --channel discord --target "$channel" --message "$msg" \
    > /dev/null 2>&1 || true
}

on_exit() {
  local exit_code=$?
  if [[ $exit_code -ne 0 && -n "$LINEAR_ISSUE_ID" ]]; then
    linear_set_status "$LINEAR_ISSUE_ID" "Todo"
    linear_add_comment "$LINEAR_ISSUE_ID" "eng-codex failed ❌\n\nTask returned to Todo for retry.\nError: check task logs for \`${TASK_ID}\`\nRepo: \`${OWNER_REPO}\`"
    discord_notify "eng-codex failed ❌ | Task: ${TASK_ID} | Repo: ${OWNER_REPO} | Check Linear for details"
  fi
}
trap on_exit EXIT

# ── Linear helpers ────────────────────────────────────────────────────────────
linear_get_state_id() {
  local issue_id="$1" state_name="$2"
  [[ -z "$LINEAR_API_KEY" || -z "$issue_id" ]] && return 0
  curl -s -X POST https://api.linear.app/graphql \
    -H "Authorization: ${LINEAR_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"{ issue(id: \\\"${issue_id}\\\") { team { states { nodes { id name } } } } }\"}" \
    | python3 -c "
import json,sys
try:
  states = json.load(sys.stdin)['data']['issue']['team']['states']['nodes']
  match = next((s for s in states if s['name'] == '${state_name}'), None)
  print(match['id'] if match else '')
except: print('')
" 2>/dev/null
}

linear_set_status() {
  local issue_id="$1" state_name="$2"
  [[ -z "$LINEAR_API_KEY" || -z "$issue_id" ]] && return 0
  local state_id
  state_id=$(linear_get_state_id "$issue_id" "$state_name")
  [[ -z "$state_id" ]] && { log "WARN" "Linear state '${state_name}' not found — skipping"; return 0; }
  curl -s -X POST https://api.linear.app/graphql \
    -H "Authorization: ${LINEAR_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"mutation { issueUpdate(id: \\\"${issue_id}\\\", input: { stateId: \\\"${state_id}\\\" }) { success } }\"}" \
    > /dev/null \
    && log "INFO" "Linear issue ${issue_id} → ${state_name}" \
    || log "WARN" "Linear status update failed"
}

linear_add_comment() {
  local issue_id="$1" body="$2"
  [[ -z "$LINEAR_API_KEY" || -z "$issue_id" ]] && return 0
  local payload
  payload=$(python3 -c "
import json, sys
issue_id, body = sys.argv[1], sys.argv[2]
query = 'mutation { commentCreate(input: { issueId: \"%s\", body: %s }) { success } }' % (
    issue_id, json.dumps(body)
)
print(json.dumps({'query': query}))
" "$issue_id" "$body")
  curl -s -X POST https://api.linear.app/graphql \
    -H "Authorization: ${LINEAR_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    > /dev/null || log "WARN" "Linear comment failed"
}

linear_fetch_comments() {
  local issue_id="$1"
  [[ -z "$LINEAR_API_KEY" || -z "$issue_id" ]] && echo "" && return 0
  curl -s -X POST https://api.linear.app/graphql \
    -H "Authorization: ${LINEAR_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"{ issue(id: \\\"${issue_id}\\\") { comments { nodes { body createdAt user { name } } } } }\"}" \
    | python3 -c "
import json, sys
try:
  nodes = json.load(sys.stdin)['data']['issue']['comments']['nodes']
  if not nodes:
    print('')
  else:
    lines = []
    for c in nodes:
      author = c.get('user', {}).get('name', 'unknown')
      ts = c.get('createdAt', '')[:10]
      lines.append(f'[{ts}] {author}: {c[\"body\"]}')
    print('\n'.join(lines))
except:
  print('')
" 2>/dev/null
}

# ── Pre-flight ────────────────────────────────────────────────────────────────
log "INFO" "Starting task: ${TASK} | repo: ${OWNER_REPO} | complexity: ${COMPLEXITY}"
bash "${SKILL_DIR}/preflight.sh" || fail "Pre-flight checks failed"

# ── Fetch Linear comments ─────────────────────────────────────────────────────
LINEAR_COMMENTS=""
if [[ -n "$LINEAR_ISSUE_ID" ]]; then
  LINEAR_COMMENTS=$(linear_fetch_comments "$LINEAR_ISSUE_ID")
  [[ -n "$LINEAR_COMMENTS" ]] && log "INFO" "Fetched Linear comments for ${LINEAR_ISSUE_ID}"
fi

# Build comment block for prompt injection (empty string if no comments)
COMMENTS_BLOCK=""
if [[ -n "$LINEAR_COMMENTS" ]]; then
  COMMENTS_BLOCK="
## Comments on this issue (read carefully — may contain requirements or feedback)
${LINEAR_COMMENTS}
"
fi

# ── Clone or update repo ──────────────────────────────────────────────────────
mkdir -p "${REPOS_DIR}/$(dirname "${OWNER_REPO}")"
if [[ ! -d "${REPO_DIR}/.git" ]]; then
  log "INFO" "Cloning ${OWNER_REPO}..."
  git clone "git@github.com:${OWNER_REPO}.git" "${REPO_DIR}" || fail "Clone failed for ${OWNER_REPO}"
else
  log "INFO" "Fetching latest from ${OWNER_REPO}..."
  git -C "${REPO_DIR}" fetch --prune --quiet || log "WARN" "Fetch failed — proceeding with cached copy"
fi

# ── Create worktree ───────────────────────────────────────────────────────────
DEFAULT_BRANCH=$(git -C "${REPO_DIR}" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo "main")
git -C "${REPO_DIR}" worktree add -b "${BRANCH}" "${WORKTREE}" "origin/${DEFAULT_BRANCH}" \
  || fail "Failed to create worktree at ${WORKTREE}"
log "INFO" "Worktree created: ${WORKTREE} (branch: ${BRANCH})"

# Create .eng dirs inside worktree
mkdir -p "${WORKTREE}/.eng"

# Export for Codex subprocess inheritance
export LINEAR_API_KEY LINEAR_ISSUE_ID

# Write Linear question helper so Codex can post blockers/questions to the ticket
if [[ -n "$LINEAR_ISSUE_ID" && -n "${LINEAR_API_KEY:-}" ]]; then
  cat > "${WORKTREE}/.eng/linear-ask.sh" <<'SCRIPT'
#!/usr/bin/env bash
# Usage: bash .eng/linear-ask.sh "Your question or blocker"
ISSUE_ID="${LINEAR_ISSUE_ID:-}"
API_KEY="${LINEAR_API_KEY:-}"
MSG="${1:-}"
[[ -z "$ISSUE_ID" || -z "$API_KEY" || -z "$MSG" ]] && { echo "Usage: linear-ask.sh <message>" >&2; exit 1; }
PAYLOAD=$(python3 -c "
import json, sys
issue_id, msg = sys.argv[1], sys.argv[2]
body = '🤔 **Codex question/blocker:**\n\n' + msg
query = 'mutation { commentCreate(input: { issueId: \"%s\", body: %s }) { success } }' % (
    issue_id, json.dumps(body)
)
print(json.dumps({'query': query}))
" "$ISSUE_ID" "$MSG")
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  > /dev/null && echo "Posted to Linear" || { echo "Failed to post to Linear" >&2; exit 1; }
SCRIPT
  chmod +x "${WORKTREE}/.eng/linear-ask.sh"
fi

# Mark issue as In Progress
[[ -n "$LINEAR_ISSUE_ID" ]] && linear_set_status "$LINEAR_ISSUE_ID" "In Progress"

# ── Phase execution ───────────────────────────────────────────────────────────
COMMIT_HASH=""

run_codex_phase() {
  local phase="$1"
  local prompt="$2"
  local phase_timeout="${3:-600}"
  local phase_log="${WORKTREE}/.eng/phase-${phase}.log"

  log "INFO" "Running phase: ${phase} (timeout: ${phase_timeout}s)"
  (
    cd "${WORKTREE}"
    timeout "${phase_timeout}" codex exec -s danger-full-access --ephemeral "${prompt}" 2>&1 \
      | tee -a "${phase_log}"
  )
  local exit_code="${PIPESTATUS[0]}"

  # Doom-loop detection: only run if codex exited non-zero
  # Matches actual shell failures only — NOT legitimate code strings in diffs
  if [[ "${exit_code}" -ne 0 && -f "${phase_log}" ]]; then
    local repeated_error
    repeated_error=$(tail -30 "${phase_log}" | sort | uniq -c | sort -rn | \
      awk '$1 >= 5 && /exit code [1-9]|command not found|permission denied|No such file|STUCK/ {print; exit}' || true)
    if [[ -n "$repeated_error" ]]; then
      log "ERROR" "DOOM-LOOP detected in phase ${phase}: ${repeated_error}"
      echo "STUCK: Doom-loop detected after 5+ repeated shell failures. Stopping." >&2
      return 2
    fi
  fi

  return "${exit_code}"
}

if [[ "$COMPLEXITY" == "trivial" ]]; then
  # ── Trivial: single invocation ────────────────────────────────────────────
  run_codex_phase "implement" \
    "Task: ${TASK}
${COMMENTS_BLOCK}
Repository: ${OWNER_REPO}
Before making any changes, start with docs:
1. AGENTS.md
2. README.md
3. docs/ directory files relevant to the task
Then implement the task in this git worktree, run tests/checks, and commit.
Never push. Write a clear commit message.
If you are blocked or need clarification, post a question: bash .eng/linear-ask.sh \"Your question\"" \
    600 \
    || fail "Codex invocation failed"

else
  # ── Standard/Complex: three-phase ─────────────────────────────────────────

  # Phase 1: Research (8 min)
  run_codex_phase "research" \
    "Task: ${TASK}
${COMMENTS_BLOCK}
Repository: ${OWNER_REPO}
Your job is RESEARCH ONLY — do not write any code yet.
Start by reading docs first:
1. AGENTS.md
2. README.md
3. docs/ directory files relevant to this task
Then explore the codebase and find:
- Relevant files and their purposes
- Existing patterns and conventions
- Data flows involved
- Potential risks or gotchas

Write your findings to .eng/research-${TASK_ID}.md in this directory.
Be thorough but concise.
If you are blocked or need clarification, post a question: bash .eng/linear-ask.sh \"Your question\"" \
    480 \
    || log "WARN" "Research phase exited non-zero — proceeding anyway"

  # Phase 2: Plan (5 min)
  run_codex_phase "plan" \
    "Task: ${TASK}

Repository: ${OWNER_REPO}
Read .eng/research-${TASK_ID}.md if it exists.
Re-check docs before planning:
1. README.md
2. docs/ directory files relevant to this task
Your job is PLANNING ONLY — do not write any code yet.
Produce a numbered implementation plan and write it to .eng/plan-${TASK_ID}.md.
Include:
1. Ordered steps
2. Files to create or modify per step
3. Test strategy (what to run and what to verify)" \
    300 \
    || log "WARN" "Plan phase exited non-zero — proceeding anyway"

  # Phase 3: Implement (20 min)
  run_codex_phase "implement" \
    "Task: ${TASK}

Repository: ${OWNER_REPO}
Before implementing, confirm you have reviewed:
1. README.md
2. docs/ directory files relevant to this task
Read .eng/plan-${TASK_ID}.md and execute it step by step.
- Use apply_patch diffs, never rewrite entire files unless new
- Run tests after each implementation block
- Write a checkpoint to .eng/progress-${TASK_ID}.md every 3-5 steps
- When done: commit all changes with a descriptive message, never push
- If the same test fails 3 times with the same error: write STUCK to .eng/progress-${TASK_ID}.md and stop
- If you need clarification or are blocked: bash .eng/linear-ask.sh \"Your question\"" \
    1200 \
    || fail "Implement phase failed"
fi

# ── Get commit hash ───────────────────────────────────────────────────────────
COMMIT_HASH=$(git -C "${WORKTREE}" log --oneline -1 --format="%H" 2>/dev/null || echo "")
if [[ -z "$COMMIT_HASH" ]]; then
  log "WARN" "No new commit detected — task may not have produced changes"
else
  log "INFO" "New commit: ${COMMIT_HASH}"
fi

# ── Review ────────────────────────────────────────────────────────────────────
REVIEW_PASSED=true
REVIEWS_DIR="${WORKSPACE}/.eng/reviews"
mkdir -p "${REVIEWS_DIR}"
if [[ -n "$COMMIT_HASH" && -f "$REVIEWER" ]]; then
  log "INFO" "Running eng-reviewer..."

  for attempt in 1 2; do
    if python3 "${REVIEWER}" "${WORKTREE}" "${COMMIT_HASH}" "${TASK_ID}-attempt${attempt}" "${TASK}" 2>&1; then
      log "INFO" "Review passed on attempt ${attempt}"
      REVIEW_PASSED=true
      break
    else
      log "WARN" "Review failed on attempt ${attempt}"
      REVIEW_PASSED=false
      if [[ "$attempt" -lt 2 ]]; then
        # Fix pass: read review issues and run a targeted Codex fix
        REVIEW_JSON="${REVIEWS_DIR}/${TASK_ID}-attempt${attempt}.json"
        if [[ -f "$REVIEW_JSON" ]]; then
          ISSUES=$(python3 -c "
import json
d = json.load(open('${REVIEW_JSON}'))
issues = d.get('issues', [])
lines = [f\"- {i.get('severity','?').upper()} in {i.get('file','?')}:{i.get('line','?')}: {i.get('description','')} — Suggestion: {i.get('suggestion','')}\" for i in issues]
print('\n'.join(lines))
" 2>/dev/null || echo "See review file for details")
          run_codex_phase "fix-${attempt}" \
            "The code review found the following issues that must be fixed:
${ISSUES}

Fix each issue. Run tests after. Commit the fixes. Never push." \
            600 \
            || log "WARN" "Fix pass ${attempt} exited non-zero"
          COMMIT_HASH=$(git -C "${WORKTREE}" log --oneline -1 --format="%H" 2>/dev/null || echo "$COMMIT_HASH")
        fi
      fi
    fi
  done
fi

# Build review body for Linear comment (try last attempt first)
REVIEW_BODY=""
for _attempt in 2 1; do
  _candidate="${REVIEWS_DIR}/${TASK_ID}-attempt${_attempt}.json"
  if [[ -f "$_candidate" ]]; then
    REVIEW_BODY=$(python3 - "$_candidate" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
summary = d.get("summary", "")
issues = d.get("issues", [])
verdict = d.get("verdict", "")
lines = []
if summary:
    lines.append("**Review summary:** " + summary)
if issues:
    lines.append("")
    lines.append("**Issues:**")
    icons = {"critical": "🔴", "major": "🟡", "minor": "🔵"}
    for i in issues:
        sev = i.get("severity", "?")
        icon = icons.get(sev, "⚪")
        f = i.get("file", "?")
        ln = i.get("line", 0)
        desc = i.get("description", "")
        sug = i.get("suggestion", "")
        lines.append(f"{icon} **{sev.upper()}** `{f}:{ln}` — {desc}")
        if sug:
            lines.append(f"  → {sug}")
elif verdict == "pass":
    lines.append("✅ No issues found.")
print("\n".join(lines))
PYEOF
    )
    break
  fi
done

# Notify on escalation (review failed both attempts)
if [[ "$REVIEW_PASSED" == "false" && -n "$COMMIT_HASH" ]]; then
  discord_notify "eng-codex review escalated ⚠️ | Task: ${TASK_ID} | Commit: ${COMMIT_HASH} | Repo: ${OWNER_REPO} | Review found issues — needs human review"
fi

# ── Push branch to GitHub ─────────────────────────────────────────────────────
if [[ -n "$COMMIT_HASH" ]]; then
  log "INFO" "Pushing ${BRANCH} to origin"
  git -C "${WORKTREE}" push origin "${BRANCH}" \
    && log "INFO" "Branch pushed: ${BRANCH}" \
    || log "WARN" "Push failed — branch available locally at ${BRANCH}"
fi

# ── Report ────────────────────────────────────────────────────────────────────
if [[ "$REVIEW_PASSED" == "true" ]]; then
  _first_json="${REVIEWS_DIR}/${TASK_ID}-attempt1.json"
  if [[ -f "$_first_json" ]] && python3 -c "import json; d=json.load(open('${_first_json}')); exit(0 if not d.get('issues') else 1)" 2>/dev/null; then
    REVIEW_STATUS="✅ no issues"
  else
    REVIEW_STATUS="✅ passed (minor issues noted)"
  fi
else
  REVIEW_STATUS="⚠️ escalated"
fi

# ── Linear update ─────────────────────────────────────────────────────────────
if [[ -n "$LINEAR_ISSUE_ID" ]]; then
  if [[ -n "$COMMIT_HASH" ]]; then
    _COMMENT="eng-codex completed — review: ${REVIEW_STATUS}

Commit: \`${COMMIT_HASH}\`
Repo: \`${OWNER_REPO}\`
Branch: \`${BRANCH}\`
GitHub: https://github.com/${OWNER_REPO}/tree/${BRANCH}"
    if [[ -n "$REVIEW_BODY" ]]; then
      _COMMENT="${_COMMENT}

---

${REVIEW_BODY}"
    fi
    linear_set_status "$LINEAR_ISSUE_ID" "In Review"
    linear_add_comment "$LINEAR_ISSUE_ID" "$_COMMENT"
  else
    linear_set_status "$LINEAR_ISSUE_ID" "Todo"
    linear_add_comment "$LINEAR_ISSUE_ID" "eng-codex run completed but produced no commit. Task may need more context or manual review.\n\nRepo: \`${OWNER_REPO}\`\nTask ID: \`${TASK_ID}\`"
  fi
fi

# ── Cleanup ───────────────────────────────────────────────────────────────────
cleanup_worktree

log "INFO" "Done. Commit: ${COMMIT_HASH:-none}. Review: ${REVIEW_STATUS}"

echo ""
echo "┌─ eng-codex result ─────────────────────────────────────────"
echo "│  Task:    ${TASK}"
echo "│  Repo:    ${OWNER_REPO}"
echo "│  Commit:  ${COMMIT_HASH:-none}"
echo "│  Review:  ${REVIEW_STATUS}"
[[ -n "$LINEAR_ISSUE_ID" ]] && echo "│  Linear:  ${LINEAR_ISSUE_ID}"
echo "└────────────────────────────────────────────────────────────"
