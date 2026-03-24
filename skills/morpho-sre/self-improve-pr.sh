#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

SELF_IMPROVE_REPO_CLONE_SCRIPT="${SELF_IMPROVE_REPO_CLONE_SCRIPT:-${SCRIPT_DIR}/repo-clone.sh}"
SELF_IMPROVE_AUTOFIX_SCRIPT="${SELF_IMPROVE_AUTOFIX_SCRIPT:-${SCRIPT_DIR}/autofix-pr.sh}"

export SELF_IMPROVE_REPORT_REPO="${SELF_IMPROVE_REPORT_REPO:-morpho-org/morpho-infra-helm}"
export SELF_IMPROVE_BOT_REPO="${SELF_IMPROVE_BOT_REPO:-morpho-org/openclaw-sre}"
export SELF_IMPROVE_INFRA_REPO="${SELF_IMPROVE_INFRA_REPO:-morpho-org/morpho-infra-helm}"
SELF_IMPROVE_BASE_BRANCH="${SELF_IMPROVE_BASE_BRANCH:-main}"
SELF_IMPROVE_BRANCH_PREFIX="${SELF_IMPROVE_BRANCH_PREFIX:-openclaw/sre-self-improve}"
SELF_IMPROVE_CONFIDENCE="${SELF_IMPROVE_CONFIDENCE:-92}"
SELF_IMPROVE_LOOKBACK_HOURS="${SELF_IMPROVE_LOOKBACK_HOURS:-24}"
SELF_IMPROVE_DEST_ROOT="${SELF_IMPROVE_DEST_ROOT:-/home/node/.openclaw/repos}"

SELF_IMPROVE_AGENT_ID="${SELF_IMPROVE_AGENT_ID:-main}"
SELF_IMPROVE_SESSIONS_DIR="${SELF_IMPROVE_SESSIONS_DIR:-/home/node/.openclaw/agents/${SELF_IMPROVE_AGENT_ID}/sessions}"
SELF_IMPROVE_REFERENCE_TIME="${SELF_IMPROVE_REFERENCE_TIME:-}"

SELF_IMPROVE_NAMESPACE="${SELF_IMPROVE_NAMESPACE:-monitoring}"
SELF_IMPROVE_DEPLOYMENT_NAME="${SELF_IMPROVE_DEPLOYMENT_NAME:-openclaw-sre}"
SELF_IMPROVE_K8S_CONTEXT="${SELF_IMPROVE_K8S_CONTEXT:-${K8S_CONTEXT:-}}"
SELF_IMPROVE_USE_KUBECTL="${SELF_IMPROVE_USE_KUBECTL:-1}"

INCIDENT_STATE_DIR="${INCIDENT_STATE_DIR:-/home/node/.openclaw/state/sentinel}"
SELF_IMPROVE_REPORT_PATH="${SELF_IMPROVE_REPORT_PATH:-skills/morpho-sre/references/self-improvement-latest.md}"
SELF_IMPROVE_HEARTBEAT_PATH="${SELF_IMPROVE_HEARTBEAT_PATH:-skills/morpho-sre/HEARTBEAT.md}"
SELF_IMPROVE_CHECK_CMD="${SELF_IMPROVE_CHECK_CMD:-}"

BLOCK_START="<!-- self-improve:start -->"
BLOCK_END="<!-- self-improve:end -->"

DRY_RUN=0

usage() {
  cat <<'EOF'
Usage:
  self-improve-pr.sh [--dry-run]

Daily loop:
1) Audit previous-day conversations from session transcripts
2) Blend transcript evidence with rolling logs + spool metrics
3) Refresh managed guidance + proposal report in morpho-infra-helm
4) Create PR through autofix-pr.sh
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

for cmd in awk bash date git grep jq node sed; do
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

build_conversation_audit_json() {
  node - "$SELF_IMPROVE_SESSIONS_DIR" "$SELF_IMPROVE_REFERENCE_TIME" <<'NODE'
const fs = require("fs");
const path = require("path");

const sessionsDir = process.argv[2];
const referenceInput = process.argv[3] || "";
const referenceTime = referenceInput ? new Date(referenceInput) : new Date();
if (Number.isNaN(referenceTime.getTime())) {
  throw new Error(`invalid SELF_IMPROVE_REFERENCE_TIME: ${referenceInput}`);
}

const failureRe =
  /\b(i don['’]t have|cannot|can['’]t|unable|failed|failure|error|missing_scope|provider_unavailable|not found|permission denied|authentication failed|timeout)\b/i;
const improvementRe =
  /\b(should|could you|can you|please|feature|improve|improvement|enhance|support|add|new)\b/i;
const infraRe =
  /\b(helm|chart|cronjob|cron|deploy|deployment|seed[\s-]*skill|configmap|values\.ya?ml|openclaw\.json|argocd|service[\s-]*account|rbac|vault|k8s|kubernetes|namespace|monitoring|environment|secret|pvc|state dir|self[\s-]*improve|repo routing|runtime config)\b/i;
const ignorableTranscriptRe =
  /\b(read heartbeat\.md|heartbeat_ok|heartbeat_to:|incident_gate|incident_routing|health_status|step_status|triage_metrics|system:\s*\[|exec denied|provider_unavailable|missing_scope|self-improve proposals?|daily self-improvement)\b/i;

function dayLabel(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalize(text, limit = 220) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}

function redact(text) {
  const clean = normalize(text, 160);
  if (!clean) return "";
  return `[redacted:${Math.min(clean.length, 160)} chars]`;
}

function extractText(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return normalize(content, 1000);
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && typeof item === "object" && item.type === "text" && typeof item.text === "string")
    .map((item) => normalize(item.text, 1000))
    .filter(Boolean)
    .join(" ");
}

function parseTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function shouldIgnoreConversation(userText, assistantText = "") {
  const haystack = `${userText} ${assistantText}`.toLowerCase();
  return ignorableTranscriptRe.test(haystack);
}

function targetRepoFor(userText, assistantText = "") {
  const haystack = `${userText} ${assistantText}`.toLowerCase();
  return infraRe.test(haystack) ? process.env.SELF_IMPROVE_INFRA_REPO : process.env.SELF_IMPROVE_BOT_REPO;
}

function summaryFor(kind, repo, userText, assistantText = "") {
  const request = normalize(userText, 140);
  if (kind === "failure") {
    const assistant = normalize(assistantText, 120);
    if (repo === process.env.SELF_IMPROVE_INFRA_REPO) {
      return `Inspect deployment/config path behind failed response for "${request}" (${assistant})`;
    }
    return `Harden bot/runtime handling for "${request}" (${assistant})`;
  }
  if (repo === process.env.SELF_IMPROVE_INFRA_REPO) {
    return `Evaluate infra/config improvement request "${request}"`;
  }
  return `Evaluate bot/runtime improvement request "${request}"`;
}

const previousDayStart = new Date(
  referenceTime.getFullYear(),
  referenceTime.getMonth(),
  referenceTime.getDate() - 1,
  0,
  0,
  0,
  0,
);
const currentDayStart = new Date(
  referenceTime.getFullYear(),
  referenceTime.getMonth(),
  referenceTime.getDate(),
  0,
  0,
  0,
  0,
);

const files = fs.existsSync(sessionsDir)
  ? fs.readdirSync(sessionsDir).filter((file) => file.endsWith(".jsonl")).sort()
  : [];

let auditedSessions = 0;
const proposals = [];

for (const file of files) {
  const fullPath = path.join(sessionsDir, file);
  let lines;
  try {
    lines = fs.readFileSync(fullPath, "utf8").split("\n");
  } catch {
    continue;
  }

  let hasWindowActivity = false;
  let lastUser;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry && typeof entry === "object" ? entry.message : undefined;
    const role = message && typeof message === "object" ? message.role : undefined;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(message);
    if (!text) continue;
    const timestampValue = entry.timestamp ?? (message && typeof message === "object" ? message.timestamp : undefined);
    const timestampMs =
      typeof timestampValue === "number" && Number.isFinite(timestampValue)
        ? timestampValue
        : parseTimestamp(timestampValue);
    const inWindow =
      timestampMs !== undefined &&
      timestampMs >= previousDayStart.getTime() &&
      timestampMs < currentDayStart.getTime();

    if (inWindow) {
      hasWindowActivity = true;
    }

    if (role === "user") {
      lastUser = {
        text,
        timestamp: typeof timestampValue === "string" ? timestampValue : undefined,
        timestampMs,
      };
      if (inWindow && improvementRe.test(text) && !shouldIgnoreConversation(text)) {
        const targetRepo = targetRepoFor(text);
        proposals.push({
          kind: "improvement",
          sessionId: file.replace(/\.jsonl$/, ""),
          timestamp: typeof timestampValue === "string" ? timestampValue : undefined,
          userText: redact(text),
          assistantText: "",
          targetRepo,
          summary: summaryFor("improvement", targetRepo, text),
        });
      }
      continue;
    }

    if (!lastUser) continue;
    if (shouldIgnoreConversation(lastUser.text, text)) continue;
    const failureTimestampMs = timestampMs ?? lastUser.timestampMs;
    const failureInWindow =
      failureTimestampMs !== undefined &&
      failureTimestampMs >= previousDayStart.getTime() &&
      failureTimestampMs < currentDayStart.getTime();
    if (!failureInWindow || !failureRe.test(text)) continue;
    const targetRepo = targetRepoFor(lastUser.text, text);
    proposals.push({
      kind: "failure",
      sessionId: file.replace(/\.jsonl$/, ""),
      timestamp: typeof timestampValue === "string" ? timestampValue : lastUser.timestamp,
      userText: redact(lastUser.text),
      assistantText: redact(text),
      targetRepo,
      summary: summaryFor("failure", targetRepo, lastUser.text, text),
    });
  }

  if (hasWindowActivity) {
    auditedSessions += 1;
  }
}

const deduped = [];
const seen = new Set();
for (const proposal of proposals) {
  const key = [
    proposal.targetRepo,
    proposal.kind,
    proposal.sessionId,
    proposal.userText,
    proposal.assistantText,
  ].join("|");
  if (seen.has(key)) continue;
  seen.add(key);
  deduped.push(proposal);
}

deduped.sort((a, b) => {
  const aTs = a.timestamp ? Date.parse(a.timestamp) : 0;
  const bTs = b.timestamp ? Date.parse(b.timestamp) : 0;
  return aTs - bTs;
});

const limited = [];
const perRepoCounts = new Map();
for (const proposal of deduped) {
  const count = perRepoCounts.get(proposal.targetRepo) ?? 0;
  if (count >= 8) continue;
  perRepoCounts.set(proposal.targetRepo, count + 1);
  limited.push(proposal);
}

const result = {
  auditedDay: dayLabel(previousDayStart),
  windowStartIso: previousDayStart.toISOString(),
  windowEndIso: currentDayStart.toISOString(),
  auditedSessions,
  proposals: limited,
  counts: {
    total: limited.length,
    failures: limited.filter((item) => item.kind === "failure").length,
    improvements: limited.filter((item) => item.kind === "improvement").length,
    bot: limited.filter((item) => item.targetRepo === process.env.SELF_IMPROVE_BOT_REPO).length,
    infra: limited.filter((item) => item.targetRepo === process.env.SELF_IMPROVE_INFRA_REPO).length,
  },
};

process.stdout.write(`${JSON.stringify(result)}\n`);
NODE
}

render_proposals_markdown() {
  local target_repo="$1"
  local json="$2"
  jq -r --arg target "$target_repo" '
    .proposals
    | map(select(.targetRepo == $target))
    | if length == 0 then
        "- none identified"
      else
        .[]
        | "- [" + .sessionId + (if .timestamp then " @ " + .timestamp else "" end) + "] " + .kind + ": " + .summary + "\n  user: \"" + .userText + "\"" + (if .assistantText != "" then "\n  assistant: \"" + .assistantText + "\"" else "" end)
      end
  ' <<<"$json"
}

behavior_logs="$(collect_logs_text)"
behavior_spool="$(collect_spool_text)"
behavior_text="${behavior_logs}"$'\n'"${behavior_spool}"
conversation_json="$(build_conversation_audit_json)"

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

focus_title="Conversation-driven repo routing"
focus_reason="Refresh self-improve proposals from previous-day transcripts and label each follow-up for bot/product code (${SELF_IMPROVE_BOT_REPO}) or deployment/config/seed-skill work (${SELF_IMPROVE_INFRA_REPO})."

SELF_IMPROVE_REPO="$SELF_IMPROVE_REPORT_REPO"
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
audited_day="$(jq -r '.auditedDay' <<<"$conversation_json")"
audited_sessions="$(jq -r '.auditedSessions' <<<"$conversation_json")"
bot_proposals_count="$(jq -r '.counts.bot' <<<"$conversation_json")"
infra_proposals_count="$(jq -r '.counts.infra' <<<"$conversation_json")"
failure_proposals_count="$(jq -r '.counts.failures' <<<"$conversation_json")"
improvement_proposals_count="$(jq -r '.counts.improvements' <<<"$conversation_json")"

report_tmp="$(mktemp)"
cat >"$report_tmp" <<EOF
# Daily SRE Bot Self-Improvement Report

- Generated (UTC): ${generated_at}
- Repo: ${SELF_IMPROVE_REPO}
- Base branch: ${SELF_IMPROVE_BASE_BRANCH}
- Conversation audit day (local): ${audited_day}
- Transcript sessions audited: ${audited_sessions}
- Rolling logs/spool lookback: ${SELF_IMPROVE_LOOKBACK_HOURS}h
- Evaluation score: ${evaluation_score}/100

## Behavior Metrics

- triage_files_count: ${triage_files_count}
- vague_refusal_count: ${vague_refusal_count}
- ack_reaction_failure_count: ${ack_reaction_failure_count}
- github_auth_failure_count: ${github_auth_failure_count}
- rca_fallback_count: ${rca_fallback_count}

## Conversation Audit

- failure_proposals: ${failure_proposals_count}
- improvement_proposals: ${improvement_proposals_count}
- bot_repo_proposals (${SELF_IMPROVE_BOT_REPO}): ${bot_proposals_count}
- infra_repo_proposals (${SELF_IMPROVE_INFRA_REPO}): ${infra_proposals_count}

### Repo target: \`${SELF_IMPROVE_BOT_REPO}\` (product and bot code)

$(render_proposals_markdown "$SELF_IMPROVE_BOT_REPO" "$conversation_json")

### Repo target: \`${SELF_IMPROVE_INFRA_REPO}\` (deployment, config, seed skills)

$(render_proposals_markdown "$SELF_IMPROVE_INFRA_REPO" "$conversation_json")

## Selected Focus

- title: ${focus_title}
- reason: ${focus_reason}

## Applied Improvement

- Updated managed guidance block in \`${SELF_IMPROVE_HEARTBEAT_PATH}\`.
- Refreshed evidence-backed proposal report in \`${SELF_IMPROVE_REPORT_PATH}\`.
- Conversation-derived proposals now call out their target repo explicitly and describe what belongs in each one.
EOF
mv -f "$report_tmp" "$report_abs"

managed_tmp="$(mktemp)"
{
  printf 'Generated (UTC): %s\n' "$generated_at"
  printf 'Conversation audit day (local): %s\n' "$audited_day"
  printf 'Transcript sessions audited: %s\n' "$audited_sessions"
  printf 'Rolling logs/spool lookback: %sh\n' "$SELF_IMPROVE_LOOKBACK_HOURS"
  printf 'Evaluation score: %s/100\n' "$evaluation_score"
  printf 'Focus: %s\n' "$focus_title"
  printf 'Reason: %s\n' "$focus_reason"
  printf '\n'
  printf 'Proposal counts:\n'
  printf '%s\n' "- ${SELF_IMPROVE_BOT_REPO}: $bot_proposals_count"
  printf '%s\n' "- ${SELF_IMPROVE_INFRA_REPO}: $infra_proposals_count"
  printf '%s\n' "- failures: $failure_proposals_count"
  printf '%s\n' "- improvements: $improvement_proposals_count"
  printf '\n'
  printf 'Managed guidance:\n'
  printf '%s\n' '- Audit previous-day transcripts before picking the daily self-improve focus.'
  printf '%s\n' "- Route bot/runtime/code proposals to ${SELF_IMPROVE_BOT_REPO}."
  printf '%s\n' "- Route deployment/config/seed-skill proposals to ${SELF_IMPROVE_INFRA_REPO}."
  printf '%s\n' '- Ignore heartbeat/system-prompt transcript content when preparing daily self-improve proposals.'
  printf '%s\n' '- Preserve the plain-English incident summary contract in HEARTBEAT.md; keep the opening summary focused on Incident/Customer impact/Affected services/Status without reintroducing a rigid 4-line template.'
} >"$managed_tmp"

inject_managed_block "$heartbeat_abs" "$BLOCK_START" "$BLOCK_END" "$managed_tmp"
rm -f "$managed_tmp"

if git -C "$repo_path" diff --quiet -- "$SELF_IMPROVE_HEARTBEAT_PATH" "$SELF_IMPROVE_REPORT_PATH"; then
  echo "self-improve:no_change"
  exit 0
fi

if [[ -z "$SELF_IMPROVE_CHECK_CMD" ]]; then
  SELF_IMPROVE_CHECK_CMD="test -f ${SELF_IMPROVE_HEARTBEAT_PATH} && test -f ${SELF_IMPROVE_REPORT_PATH}"
fi

body_file="$(mktemp)"
cat >"$body_file" <<EOF
## Daily self-improvement automation

- Generated (UTC): ${generated_at}
- Conversation audit day (local): ${audited_day}
- Transcript sessions audited: ${audited_sessions}
- Evaluation score: ${evaluation_score}/100
- Focus: ${focus_title}

### Proposal counts

- ${SELF_IMPROVE_BOT_REPO}: ${bot_proposals_count}
- ${SELF_IMPROVE_INFRA_REPO}: ${infra_proposals_count}
- failures: ${failure_proposals_count}
- improvements: ${improvement_proposals_count}

### Changes in this PR

- Update managed daily guidance in \`${SELF_IMPROVE_HEARTBEAT_PATH}\`.
- Refresh evidence-backed proposal report in \`${SELF_IMPROVE_REPORT_PATH}\`.
- Route each conversation-derived proposal toward \`${SELF_IMPROVE_BOT_REPO}\` or \`${SELF_IMPROVE_INFRA_REPO}\`.
EOF

title="chore(sre): daily self-improvement proposals"
commit_msg="chore(sre): daily self-improvement proposals"

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
