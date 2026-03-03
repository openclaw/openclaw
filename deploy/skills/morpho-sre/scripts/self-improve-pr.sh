#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

SELF_IMPROVE_REPO_CLONE_SCRIPT="${SELF_IMPROVE_REPO_CLONE_SCRIPT:-${SCRIPT_DIR}/repo-clone.sh}"
SELF_IMPROVE_AUTOFIX_SCRIPT="${SELF_IMPROVE_AUTOFIX_SCRIPT:-${SCRIPT_DIR}/autofix-pr.sh}"

SELF_IMPROVE_REPO="${SELF_IMPROVE_REPO:-morpho-org/openclaw-sre}"
SELF_IMPROVE_BASE_BRANCH="${SELF_IMPROVE_BASE_BRANCH:-main}"
SELF_IMPROVE_BRANCH_PREFIX="${SELF_IMPROVE_BRANCH_PREFIX:-openclaw/sre-self-improve}"
SELF_IMPROVE_CONFIDENCE="${SELF_IMPROVE_CONFIDENCE:-92}"
SELF_IMPROVE_LOOKBACK_HOURS="${SELF_IMPROVE_LOOKBACK_HOURS:-24}"
SELF_IMPROVE_DEST_ROOT="${SELF_IMPROVE_DEST_ROOT:-/home/node/.openclaw/repos}"

SELF_IMPROVE_NAMESPACE="${SELF_IMPROVE_NAMESPACE:-monitoring}"
SELF_IMPROVE_DEPLOYMENT_NAME="${SELF_IMPROVE_DEPLOYMENT_NAME:-openclaw-sre}"
SELF_IMPROVE_K8S_CONTEXT="${SELF_IMPROVE_K8S_CONTEXT:-${K8S_CONTEXT:-}}"
SELF_IMPROVE_USE_KUBECTL="${SELF_IMPROVE_USE_KUBECTL:-1}"

INCIDENT_STATE_DIR="${INCIDENT_STATE_DIR:-/home/node/.openclaw/state/sentinel}"
SELF_IMPROVE_REPORT_PATH="${SELF_IMPROVE_REPORT_PATH:-deploy/skills/morpho-sre/references/self-improvement-latest.md}"
SELF_IMPROVE_HEARTBEAT_PATH="${SELF_IMPROVE_HEARTBEAT_PATH:-deploy/skills/morpho-sre/HEARTBEAT.md}"
SELF_IMPROVE_CHECK_CMD="${SELF_IMPROVE_CHECK_CMD:-}"

BLOCK_START="<!-- self-improve:start -->"
BLOCK_END="<!-- self-improve:end -->"

DRY_RUN=0

usage() {
  cat <<'EOF'
Usage:
  self-improve-pr.sh [--dry-run]

Daily loop:
1) Evaluate recent bot behavior (logs + spool evidence)
2) Update managed behavior guidance + evaluation report in target repo
3) Create PR through autofix-pr.sh
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      usage
      exit 1
      ;;
  esac
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

for cmd in awk bash date git grep jq sed; do
  require_cmd "$cmd"
done

for file in "$SELF_IMPROVE_REPO_CLONE_SCRIPT" "$SELF_IMPROVE_AUTOFIX_SCRIPT"; do
  if [[ ! -x "$file" ]]; then
    echo "missing executable: $file" >&2
    exit 1
  fi
done

is_int() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

if ! is_int "$SELF_IMPROVE_LOOKBACK_HOURS" || [[ "$SELF_IMPROVE_LOOKBACK_HOURS" -lt 1 ]]; then
  echo "SELF_IMPROVE_LOOKBACK_HOURS must be >= 1 (got: $SELF_IMPROVE_LOOKBACK_HOURS)" >&2
  exit 1
fi

if ! is_int "$SELF_IMPROVE_CONFIDENCE" || [[ "$SELF_IMPROVE_CONFIDENCE" -lt 0 || "$SELF_IMPROVE_CONFIDENCE" -gt 100 ]]; then
  echo "SELF_IMPROVE_CONFIDENCE must be 0-100 (got: $SELF_IMPROVE_CONFIDENCE)" >&2
  exit 1
fi

utc_now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

collect_logs_text() {
  if [[ "$SELF_IMPROVE_USE_KUBECTL" != "1" ]]; then
    return 0
  fi
  if ! command -v kubectl >/dev/null 2>&1; then
    return 0
  fi

  local -a cmd=(kubectl)
  if [[ -n "$SELF_IMPROVE_K8S_CONTEXT" ]]; then
    cmd+=(--context "$SELF_IMPROVE_K8S_CONTEXT")
  fi
  cmd+=(
    -n "$SELF_IMPROVE_NAMESPACE"
    logs
    "deployment/${SELF_IMPROVE_DEPLOYMENT_NAME}"
    "--since=${SELF_IMPROVE_LOOKBACK_HOURS}h"
  )
  "${cmd[@]}" 2>/dev/null || true
}

collect_spool_text() {
  local spool_dir="${INCIDENT_STATE_DIR%/}/spool"
  local minutes
  minutes=$((SELF_IMPROVE_LOOKBACK_HOURS * 60))
  if [[ ! -d "$spool_dir" ]]; then
    return 0
  fi

  find "$spool_dir" -maxdepth 1 -type f -name 'triage-*' -mmin "-${minutes}" -print 2>/dev/null \
    | sort \
    | tail -n 400 \
    | while IFS= read -r f; do
        [[ -f "$f" ]] || continue
        cat "$f"
        printf '\n'
      done
}

count_matches() {
  local haystack="$1"
  local pattern="$2"
  printf '%s\n' "$haystack" | grep -Eic "$pattern" || true
}

inject_managed_block() {
  local file="$1"
  local start="$2"
  local end="$3"
  local block_file="$4"
  local tmp_file="${file}.tmp.$$"

  awk -v start="$start" -v end="$end" -v block="$block_file" '
    BEGIN { in_block = 0; inserted = 0 }
    {
      if ($0 == start) {
        print $0
        while ((getline line < block) > 0) print line
        close(block)
        in_block = 1
        inserted = 1
        next
      }
      if (in_block == 1) {
        if ($0 == end) {
          in_block = 0
          print $0
        }
        next
      }
      print $0
    }
    END {
      if (inserted == 0) {
        print ""
        print "## Daily Self-Improvement (Managed)"
        print start
        while ((getline line < block) > 0) print line
        close(block)
        print end
      }
    }
  ' "$file" >"$tmp_file"
  mv -f "$tmp_file" "$file"
}

behavior_logs="$(collect_logs_text)"
behavior_spool="$(collect_spool_text)"
behavior_text="${behavior_logs}"$'\n'"${behavior_spool}"

triage_files_count=0
if [[ -d "${INCIDENT_STATE_DIR%/}/spool" ]]; then
  triage_files_count="$(find "${INCIDENT_STATE_DIR%/}/spool" -maxdepth 1 -type f -name 'triage-*' -mmin "-$((SELF_IMPROVE_LOOKBACK_HOURS * 60))" 2>/dev/null | wc -l | tr -d '[:space:]')"
fi
if ! is_int "$triage_files_count"; then
  triage_files_count=0
fi

vague_refusal_count="$(count_matches "$behavior_text" 'insufficient context|not enough context|cannot answer|can.t answer|need more context')"
ack_reaction_failure_count="$(count_matches "$behavior_text" 'failed to send progress ack reaction|missing_scope')"
github_auth_failure_count="$(count_matches "$behavior_text" 'github[^[:cntrl:]]*(401|403|bad credentials|auth failed|no successful github actions queries)')"
rca_fallback_count="$(count_matches "$behavior_text" 'ranked_hypotheses fallback|heuristic fallback|codex unavailable')"

if ! is_int "$vague_refusal_count"; then vague_refusal_count=0; fi
if ! is_int "$ack_reaction_failure_count"; then ack_reaction_failure_count=0; fi
if ! is_int "$github_auth_failure_count"; then github_auth_failure_count=0; fi
if ! is_int "$rca_fallback_count"; then rca_fallback_count=0; fi

evaluation_score=$((100 - (vague_refusal_count * 6) - (github_auth_failure_count * 8) - (ack_reaction_failure_count * 5) - (rca_fallback_count * 2)))
if [[ "$evaluation_score" -lt 0 ]]; then
  evaluation_score=0
fi

focus_key="proactive_hardening"
focus_title="Proactive hardening"
focus_reason="No dominant regression detected. Keep infer-first + auth/reaction fallback rules reinforced."

if [[ "$github_auth_failure_count" -gt 0 ]]; then
  focus_key="github_auth_refresh"
  focus_title="GitHub auth refresh resilience"
  focus_reason="Detected GitHub auth failures in recent behavior. Reinforce app-token refresh before failure response."
elif [[ "$vague_refusal_count" -gt 0 ]]; then
  focus_key="vague_request_inference"
  focus_title="Infer-first handling for vague asks"
  focus_reason="Detected vague/insufficient-context refusals. Reinforce assumption-first + options response style."
elif [[ "$ack_reaction_failure_count" -gt 0 ]]; then
  focus_key="ack_reaction_fallback"
  focus_title="Slack ack reaction fallback"
  focus_reason="Detected reaction ack failures. Reinforce reaction-or-message fallback behavior."
elif [[ "$rca_fallback_count" -gt 5 ]]; then
  focus_key="rca_fallback_reduction"
  focus_title="RCA fallback reduction"
  focus_reason="High fallback frequency. Reinforce richer evidence + deterministic checks before escalation."
fi

guidance_tmp="$(mktemp)"
case "$focus_key" in
  github_auth_refresh)
    cat >"$guidance_tmp" <<'EOF'
- On GitHub 401/403, retry with GitHub App token before reporting failure.
- Keep strict repo-access preflight so expired env tokens do not fail-open.
- If all auth paths fail, return explicit blocked reason + manual operator step.
EOF
    ;;
  vague_request_inference)
    cat >"$guidance_tmp" <<'EOF'
- For vague asks, infer likely intent from thread context first.
- State one explicit assumption, then provide 2-3 concrete options/commands.
- Ask at most one clarifying question only if it changes the recommendation.
EOF
    ;;
  ack_reaction_fallback)
    cat >"$guidance_tmp" <<'EOF'
- Prefer 👀 reaction for in-progress ack.
- On missing_scope or reaction failure, fallback to thread message: 👀.
- Never leave user without an immediate ack signal.
EOF
    ;;
  rca_fallback_reduction)
    cat >"$guidance_tmp" <<'EOF'
- Prioritize complete evidence bundle before Step 11.
- When degraded, return highest-confidence deterministic hypothesis + verification commands.
- Track fallback reasons explicitly for follow-up tuning.
EOF
    ;;
  *)
    cat >"$guidance_tmp" <<'EOF'
- Keep infer-first behavior for vague asks (assumption + options).
- Keep GitHub token-refresh fallback active on auth errors.
- Keep 👀 reaction ack path and missing-scope message fallback.
EOF
    ;;
esac

clone_output="$(DEST_ROOT="$SELF_IMPROVE_DEST_ROOT" bash "$SELF_IMPROVE_REPO_CLONE_SCRIPT" --repo "$SELF_IMPROVE_REPO" --ref "$SELF_IMPROVE_BASE_BRANCH")"
repo_path="$(printf '%s\n' "$clone_output" | awk -F'=' '/^path=/{print $2; exit}')"
if [[ -z "$repo_path" || ! -d "$repo_path" ]]; then
  echo "failed to resolve cloned repo path from repo-clone.sh output" >&2
  printf '%s\n' "$clone_output" >&2
  exit 1
fi
if ! git -C "$repo_path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "resolved repo path is not a git repository: $repo_path" >&2
  exit 1
fi

heartbeat_abs="${repo_path%/}/${SELF_IMPROVE_HEARTBEAT_PATH}"
report_abs="${repo_path%/}/${SELF_IMPROVE_REPORT_PATH}"
mkdir -p "$(dirname "$heartbeat_abs")" "$(dirname "$report_abs")"

if [[ ! -f "$heartbeat_abs" ]]; then
  cat >"$heartbeat_abs" <<'EOF'
# Morpho SRE Sentinel
EOF
fi

generated_at="$(utc_now_iso)"

report_tmp="$(mktemp)"
cat >"$report_tmp" <<EOF
# Daily SRE Bot Self-Improvement Report

- Generated (UTC): ${generated_at}
- Repo: ${SELF_IMPROVE_REPO}
- Base branch: ${SELF_IMPROVE_BASE_BRANCH}
- Lookback: ${SELF_IMPROVE_LOOKBACK_HOURS}h
- Evaluation score: ${evaluation_score}/100

## Behavior Metrics

- triage_files_count: ${triage_files_count}
- vague_refusal_count: ${vague_refusal_count}
- ack_reaction_failure_count: ${ack_reaction_failure_count}
- github_auth_failure_count: ${github_auth_failure_count}
- rca_fallback_count: ${rca_fallback_count}

## Selected Focus

- key: \`${focus_key}\`
- title: ${focus_title}
- reason: ${focus_reason}

## Applied Improvement

- Updated managed guidance block in \`${SELF_IMPROVE_HEARTBEAT_PATH}\`.
- Goal: bias bot toward higher-quality default behavior from observed regressions.
EOF
mv -f "$report_tmp" "$report_abs"

managed_tmp="$(mktemp)"
{
  printf 'Generated (UTC): %s\n' "$generated_at"
  printf 'Lookback: %sh\n' "$SELF_IMPROVE_LOOKBACK_HOURS"
  printf 'Evaluation score: %s/100\n' "$evaluation_score"
  printf 'Focus: %s\n' "$focus_title"
  printf 'Reason: %s\n' "$focus_reason"
  printf '\n'
  printf 'Metrics:\n'
  printf '%s\n' "- triage_files_count: $triage_files_count"
  printf '%s\n' "- vague_refusal_count: $vague_refusal_count"
  printf '%s\n' "- ack_reaction_failure_count: $ack_reaction_failure_count"
  printf '%s\n' "- github_auth_failure_count: $github_auth_failure_count"
  printf '%s\n' "- rca_fallback_count: $rca_fallback_count"
  printf '\n'
  printf 'Managed guidance:\n'
  cat "$guidance_tmp"
} >"$managed_tmp"

inject_managed_block "$heartbeat_abs" "$BLOCK_START" "$BLOCK_END" "$managed_tmp"
rm -f "$managed_tmp" "$guidance_tmp"

if git -C "$repo_path" diff --quiet -- "$SELF_IMPROVE_HEARTBEAT_PATH" "$SELF_IMPROVE_REPORT_PATH"; then
  echo "self-improve:no_change"
  exit 0
fi

if [[ -z "$SELF_IMPROVE_CHECK_CMD" ]]; then
  if [[ -f "$repo_path/deploy/skills/morpho-sre/scripts/test-service-graph.sh" && -f "$repo_path/deploy/skills/morpho-sre/scripts/test-relationship-knowledge-build.sh" ]]; then
    SELF_IMPROVE_CHECK_CMD="bash deploy/skills/morpho-sre/scripts/test-service-graph.sh && bash deploy/skills/morpho-sre/scripts/test-relationship-knowledge-build.sh"
  else
    SELF_IMPROVE_CHECK_CMD="bash -n ${SELF_IMPROVE_HEARTBEAT_PATH}"
  fi
fi

body_file="$(mktemp)"
cat >"$body_file" <<EOF
## Daily self-improvement automation

- Generated (UTC): ${generated_at}
- Lookback: ${SELF_IMPROVE_LOOKBACK_HOURS}h
- Evaluation score: ${evaluation_score}/100
- Focus: ${focus_title}

### Metrics

- triage_files_count: ${triage_files_count}
- vague_refusal_count: ${vague_refusal_count}
- ack_reaction_failure_count: ${ack_reaction_failure_count}
- github_auth_failure_count: ${github_auth_failure_count}
- rca_fallback_count: ${rca_fallback_count}

### Changes in this PR

- Update managed daily guidance in \`${SELF_IMPROVE_HEARTBEAT_PATH}\`.
- Refresh daily evaluation report in \`${SELF_IMPROVE_REPORT_PATH}\`.
EOF

title="chore(sre): daily bot self-improvement tuneup"
commit_msg="chore(sre): daily bot self-improvement tuneup"

autofix_args=(
  --repo "$SELF_IMPROVE_REPO"
  --path "$repo_path"
  --title "$title"
  --commit "$commit_msg"
  --confidence "$SELF_IMPROVE_CONFIDENCE"
  --base "$SELF_IMPROVE_BASE_BRANCH"
  --body-file "$body_file"
  --check-cmd "$SELF_IMPROVE_CHECK_CMD"
  --files "${SELF_IMPROVE_HEARTBEAT_PATH},${SELF_IMPROVE_REPORT_PATH}"
)

if [[ "$DRY_RUN" -eq 1 ]]; then
  autofix_args+=(--dry-run)
fi

AUTO_PR_BRANCH_PREFIX="$SELF_IMPROVE_BRANCH_PREFIX" bash "$SELF_IMPROVE_AUTOFIX_SCRIPT" "${autofix_args[@]}"
