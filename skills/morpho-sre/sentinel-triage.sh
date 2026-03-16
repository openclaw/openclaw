#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

for cmd in awk cksum date jq kubectl sed shasum sort tr; do
  require_cmd "$cmd"
done

SCOPE_NAMESPACES="${SCOPE_NAMESPACES:-morpho-dev,monitoring}"
POD_LIMIT="${POD_LIMIT:-20}"
DEPLOY_LIMIT="${DEPLOY_LIMIT:-20}"
EVENT_LIMIT="${EVENT_LIMIT:-30}"
ALERT_LIMIT="${ALERT_LIMIT:-25}"
CONTAINER_LIMIT="${CONTAINER_LIMIT:-30}"
LOG_SNIPPET_PODS_LIMIT="${LOG_SNIPPET_PODS_LIMIT:-5}"
LOG_SNIPPET_LINES="${LOG_SNIPPET_LINES:-120}"
LOG_SNIPPET_ERRORS_PER_CONTAINER="${LOG_SNIPPET_ERRORS_PER_CONTAINER:-3}"
RESTART_THRESHOLD="${RESTART_THRESHOLD:-3}"
KUBECTL_TIMEOUT="${KUBECTL_TIMEOUT:-90s}"
K8S_CONTEXT="${K8S_CONTEXT:-$(kubectl config current-context 2>/dev/null || echo in-cluster)}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://prometheus-stack-kube-prom-prometheus.monitoring.svc.cluster.local:9090}"
PROMETHEUS_TIMEOUT_SECONDS="${PROMETHEUS_TIMEOUT_SECONDS:-120}"
ARGOCD_BASE_URL="${ARGOCD_BASE_URL:-}"
ARGOCD_TIMEOUT_SECONDS="${ARGOCD_TIMEOUT_SECONDS:-120}"
IGNORE_ALERTNAMES="${IGNORE_ALERTNAMES:-Watchdog,CPUThrottlingHigh,KubeControllerManagerDown,KubeSchedulerDown,KubeJobFailed,KubeDeploymentReplicasMismatch,KubeDeploymentRolloutStuck,KubeHpaMaxedOut}"
RCA_SCRIPT_DIR="${RCA_SCRIPT_DIR:-${SCRIPT_DIR}}"
INCLUDE_REPO_MAP="${INCLUDE_REPO_MAP:-1}"
INCLUDE_CI_SIGNAL="${INCLUDE_CI_SIGNAL:-1}"
INCLUDE_LOG_SNIPPETS="${INCLUDE_LOG_SNIPPETS:-1}"
INCLUDE_IMAGE_REVISION="${INCLUDE_IMAGE_REVISION:-1}"
RCA_MODE="${RCA_MODE:-single}"
RCA_CHAIN_ENABLED="${RCA_CHAIN_ENABLED:-0}"
SERVICE_CONTEXT_ENABLED="${SERVICE_CONTEXT_ENABLED:-0}"
INCIDENT_LEARNING_ENABLED="${INCIDENT_LEARNING_ENABLED:-0}"
RCA_ENRICH_LIMIT="${RCA_ENRICH_LIMIT:-8}"
CI_REPO_LIMIT="${CI_REPO_LIMIT:-3}"
CI_RUN_LIMIT="${CI_RUN_LIMIT:-3}"
LINEAR_MEMORY_LIMIT="${LINEAR_MEMORY_LIMIT:-5}"
ALERT_COOLDOWN_SECONDS="${ALERT_COOLDOWN_SECONDS:-1800}"
ALERT_MIN_INTERVAL_SECONDS="${ALERT_MIN_INTERVAL_SECONDS:-3600}"
RCA_MIN_RERUN_INTERVAL_S="${RCA_MIN_RERUN_INTERVAL_S:-3600}"
RCA_EVIDENCE_TOTAL_TIMEOUT_MS="${RCA_EVIDENCE_TOTAL_TIMEOUT_MS:-80000}"
CHANGE_WINDOW_MINUTES="${CHANGE_WINDOW_MINUTES:-180}"
INCIDENT_STATE_DIR="${INCIDENT_STATE_DIR:-/home/node/.openclaw/state/sentinel}"
INCIDENT_STATE_FILE="${INCIDENT_STATE_FILE:-${INCIDENT_STATE_DIR}/incident-gate.tsv}"
ACTIVE_INCIDENTS_FILE="${ACTIVE_INCIDENTS_FILE:-${INCIDENT_STATE_DIR}/active-incidents.tsv}"
RESOLVED_INCIDENTS_FILE="${RESOLVED_INCIDENTS_FILE:-${INCIDENT_STATE_DIR}/resolved-incidents.tsv}"
INCIDENT_LAST_ACTIVE_FILE="${INCIDENT_LAST_ACTIVE_FILE:-${INCIDENT_STATE_DIR}/last-active-incident-id}"
BETTERSTACK_INCIDENT_ID="${BETTERSTACK_INCIDENT_ID:-}"
BETTERSTACK_THREAD_TS="${BETTERSTACK_THREAD_TS:-}"
BETTERSTACK_CONTEXT="${BETTERSTACK_CONTEXT:-}"
SPOOL_DIR="${SPOOL_DIR:-${INCIDENT_STATE_DIR}/spool}"
META_ALERTS_METRICS_FILE="${META_ALERTS_METRICS_FILE:-${INCIDENT_STATE_DIR}/meta-alerts.tsv}"
SEVERITY_CRITICAL_SCORE="${SEVERITY_CRITICAL_SCORE:-85}"
SEVERITY_HIGH_SCORE="${SEVERITY_HIGH_SCORE:-60}"
SEVERITY_MEDIUM_SCORE="${SEVERITY_MEDIUM_SCORE:-30}"
PRIMARY_NAMESPACES="${PRIMARY_NAMESPACES:-morpho-dev}"
ROUTE_TARGET_CRITICAL="${ROUTE_TARGET_CRITICAL:-user:U07KE3NALTX}"
ROUTE_TARGET_HIGH="${ROUTE_TARGET_HIGH:-user:U07KE3NALTX}"
ROUTE_TARGET_MEDIUM="${ROUTE_TARGET_MEDIUM:-channel:#staging-infra-monitoring}"
ROUTE_TARGET_LOW="${ROUTE_TARGET_LOW:-channel:#staging-infra-monitoring}"
STEP_LEASE_TTL_SECONDS="${STEP_LEASE_TTL_SECONDS:-300}"
STEP_TIMEOUT_POD_DEPLOY_SECONDS="${STEP_TIMEOUT_POD_DEPLOY_SECONDS:-180}"
STEP_TIMEOUT_EVENTS_ALERTS_SECONDS="${STEP_TIMEOUT_EVENTS_ALERTS_SECONDS:-180}"
STEP_TIMEOUT_LINEAR_MEMORY_SECONDS="${STEP_TIMEOUT_LINEAR_MEMORY_SECONDS:-180}"
STEP_TIMEOUT_PROMETHEUS_TRENDS_SECONDS="${STEP_TIMEOUT_PROMETHEUS_TRENDS_SECONDS:-300}"
STEP_TIMEOUT_ARGOCD_SYNC_SECONDS="${STEP_TIMEOUT_ARGOCD_SYNC_SECONDS:-300}"
STEP_TIMEOUT_LOG_SIGNALS_SECONDS="${STEP_TIMEOUT_LOG_SIGNALS_SECONDS:-300}"
STEP_TIMEOUT_CERT_SECRET_HEALTH_SECONDS="${STEP_TIMEOUT_CERT_SECRET_HEALTH_SECONDS:-180}"
STEP_TIMEOUT_AWS_RESOURCE_SIGNALS_SECONDS="${STEP_TIMEOUT_AWS_RESOURCE_SIGNALS_SECONDS:-180}"
STEP_TIMEOUT_DB_EVIDENCE_SECONDS="${STEP_TIMEOUT_DB_EVIDENCE_SECONDS:-240}"
STEP_TIMEOUT_IMAGE_REPO_SECONDS="${STEP_TIMEOUT_IMAGE_REPO_SECONDS:-300}"
STEP_TIMEOUT_REVISIONS_SECONDS="${STEP_TIMEOUT_REVISIONS_SECONDS:-300}"
STEP_TIMEOUT_CI_SIGNALS_SECONDS="${STEP_TIMEOUT_CI_SIGNALS_SECONDS:-300}"
DB_EVIDENCE_ENABLED="${DB_EVIDENCE_ENABLED:-1}"
DB_EVIDENCE_NAMESPACE="${DB_EVIDENCE_NAMESPACE:-}"

TIMEOUT_IMPL="none"
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_IMPL="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_IMPL="gtimeout"
elif command -v python3 >/dev/null 2>&1; then
  TIMEOUT_IMPL="python3"
fi

parse_timeout_seconds() {
  local raw="${1:-0}"
  raw="${raw%s}"
  if [[ "$raw" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    printf '%s\n' "$raw"
    return
  fi
  printf '0\n'
}

run_with_timeout() {
  local timeout_value="$1"
  shift
  local timeout_sec
  timeout_sec="$(parse_timeout_seconds "$timeout_value")"
  case "$TIMEOUT_IMPL" in
    timeout)
      timeout "${timeout_sec}s" "$@"
      ;;
    gtimeout)
      gtimeout "${timeout_sec}s" "$@"
      ;;
    python3)
      python3 - "$timeout_sec" "$@" <<'PY'
import subprocess
import sys

timeout = float(sys.argv[1]) if len(sys.argv) > 1 else 0.0
cmd = sys.argv[2:]

if not cmd:
    sys.exit(2)

try:
    completed = subprocess.run(cmd, timeout=timeout if timeout > 0 else None)
    sys.exit(completed.returncode)
except subprocess.TimeoutExpired:
    sys.exit(124)
except FileNotFoundError:
    sys.exit(127)
PY
      ;;
    *)
      "$@"
      ;;
  esac
}

log() {
  printf '[sentinel-triage] %s\n' "$*" >&2
}

now_ms() {
  local ms
  ms="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$ms" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$ms"
    return
  fi
  printf '%s000\n' "$(date +%s 2>/dev/null || echo 0)"
}

# --- Per-step timeout infrastructure (Phase 1) ---

run_step() {
  local step_num="$1" step_name="$2" timeout_sec="$3" required="$4"
  shift 4
  local command="$*"
  local output_var="STEP_OUTPUT_${step_num}"
  local status_var="STEP_STATUS_${step_num}"
  local start_ms end_ms elapsed_ms
  local output=""
  local exit_code=0

  start_ms="$(now_ms)"
  output="$(run_with_timeout "${timeout_sec}s" bash -c "$command" 2>&1)" || exit_code=$?
  end_ms="$(now_ms)"
  elapsed_ms=$((end_ms - start_ms))
  if [[ "$elapsed_ms" -lt 0 ]]; then
    elapsed_ms=0
  fi
  local latency_var="STEP_LATENCY_${step_num}"
  printf -v "$latency_var" '%s' "$elapsed_ms"

  if [[ "$exit_code" -eq 124 ]]; then
    printf -v "$status_var" '%s' "timeout"
    printf -v "$output_var" '%s' "$output"
    log "Step ${step_num} (${step_name}): TIMEOUT after ${timeout_sec}s"
    if [[ "$required" == "yes" ]]; then
      return 1
    fi
    return 0
  fi

  if [[ "$exit_code" -ne 0 ]]; then
    printf -v "$status_var" '%s' "error"
    printf -v "$output_var" '%s' "$output"
    log "Step ${step_num} (${step_name}): ERROR (exit ${exit_code})"
    if [[ "$required" == "yes" ]]; then
      return 1
    fi
    return 0
  fi

  printf -v "$status_var" '%s' "ok"
  printf -v "$output_var" '%s' "$output"
  return 0
}

emit_step_var() {
  local name="$1"
  local value="${2:-}"
  local encoded
  encoded="$(printf '%s' "$value" | jq -Rr '@base64')"
  printf '__STEPVAR__\t%s\t%s\n' "$name" "$encoded"
}

apply_step_output() {
  local step_num="$1"
  local output_var="STEP_OUTPUT_${step_num}"
  local raw_output="${!output_var:-}"
  local filtered_output=""
  local line marker var_name encoded decoded

  while IFS= read -r line; do
    if [[ "$line" == "__STEPVAR__"$'\t'* ]]; then
      IFS=$'\t' read -r marker var_name encoded <<<"$line"
      if [[ "$var_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
        decoded="$(printf '%s' "$encoded" | jq -Rr '@base64d' 2>/dev/null || echo "")"
        printf -v "$var_name" '%s' "$decoded"
      fi
      continue
    fi
    filtered_output="${filtered_output}${line}"$'\n'
  done < <(printf '%s\n' "$raw_output")

  filtered_output="${filtered_output%$'\n'}"
  printf -v "$output_var" '%s' "$filtered_output"
}

set_step_skipped() {
  local step_num="$1"
  local status_var="STEP_STATUS_${step_num}"
  local output_var="STEP_OUTPUT_${step_num}"
  local latency_var="STEP_LATENCY_${step_num}"
  printf -v "$status_var" '%s' "skipped"
  printf -v "$output_var" '%s' ""
  printf -v "$latency_var" '%s' "0"
}

EVIDENCE_BUDGET_START_MS=0
EVIDENCE_BUDGET_EXHAUSTED=0

optional_evidence_step_allowed() {
  local step_num="$1"
  if [[ "${RCA_CHAIN_ENABLED:-0}" != "1" ]]; then
    return 0
  fi
  if ! [[ "${RCA_EVIDENCE_TOTAL_TIMEOUT_MS:-0}" =~ ^[0-9]+$ ]] || [[ "${RCA_EVIDENCE_TOTAL_TIMEOUT_MS:-0}" -le 0 ]]; then
    return 0
  fi
  if [[ "${EVIDENCE_BUDGET_EXHAUSTED:-0}" -eq 1 ]]; then
    set_step_skipped "$step_num"
    return 1
  fi

  local elapsed_ms
  elapsed_ms=$(( $(now_ms) - EVIDENCE_BUDGET_START_MS ))
  if (( elapsed_ms >= RCA_EVIDENCE_TOTAL_TIMEOUT_MS )); then
    EVIDENCE_BUDGET_EXHAUSTED=1
    log "Evidence budget exhausted (${elapsed_ms}ms >= ${RCA_EVIDENCE_TOTAL_TIMEOUT_MS}ms), skipping remaining optional steps"
    set_step_skipped "$step_num"
    return 1
  fi
  return 0
}

step_command() {
  local fn="$1"
  local needs=(emit_step_var parse_timeout_seconds run_with_timeout kctl sanitize_signal_line count_lines resolve_helper_script extract_image_tag extract_commit_hint_from_tag "$fn")
  local out="" item
  for item in "${needs[@]}"; do
    if declare -F "$item" >/dev/null 2>&1; then
      out="${out}$(declare -f "$item")"$'\n'
    fi
  done
  out="${out}${fn}"
  printf '%s' "$out"
}

kctl() {
  kubectl --context "$K8S_CONTEXT" "$@"
}

ensure_positive_int() {
  local var_name="$1"
  local default_value="$2"
  local raw_value="${!var_name:-}"
  if ! [[ "$raw_value" =~ ^[0-9]+$ ]] || [[ "$raw_value" -lt 1 ]]; then
    printf -v "$var_name" '%s' "$default_value"
  fi
}

ensure_non_negative_int() {
  local var_name="$1"
  local default_value="$2"
  local raw_value="${!var_name:-}"
  if ! [[ "$raw_value" =~ ^[0-9]+$ ]] || [[ "$raw_value" -lt 0 ]]; then
    printf -v "$var_name" '%s' "$default_value"
  fi
}

count_lines() {
  local data="${1:-}"
  if [[ -z "$data" ]]; then
    printf '0\n'
    return
  fi
  printf '%s\n' "$data" | awk 'NF > 0 { c++ } END { print c + 0 }'
}

section() {
  printf '\n=== %s ===\n' "$1"
}

to_json_array() {
  local raw="${1:-}"
  printf '%s' "$raw" \
    | tr ',' '\n' \
    | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' \
    | awk 'NF > 0 { print }' \
    | jq -Rsc 'split("\n") | map(select(length > 0))'
}

sanitize_signal_line() {
  local raw="${1:-}"
  if [[ -z "$raw" ]]; then
    printf '\n'
    return
  fi
  printf '%s\n' "$raw" \
    | jq -Rr '
        gsub("(?i)(authorization:[[:space:]]*bearer[[:space:]]+)[A-Za-z0-9._/+=-]+"; "\\1<redacted>")
        | gsub("(?i)(xox[baprs]-)[A-Za-z0-9-]+"; "\\1<redacted>")
        | gsub("(?i)(xapp-[0-9]+-)[A-Za-z0-9-]+"; "\\1<redacted>")
        | gsub("(?i)(gh[pousr]_[A-Za-z0-9_]+)"; "<redacted-gh-token>")
        | gsub("(?i)github_pat_[A-Za-z0-9_]+"; "<redacted-gh-token>")
        | gsub("AKIA[0-9A-Z]{16}"; "<redacted-aws-key>")
        | gsub("ASIA[0-9A-Z]{16}"; "<redacted-aws-sts-key>")
        | gsub("(?i)sk-ant-[A-Za-z0-9._=-]+"; "sk-ant-<redacted>")
        | gsub("(?i)hvs\\.[A-Za-z0-9._=-]+"; "hvs.<redacted>")
        | gsub("(?i)\\bs\\.[A-Za-z0-9._=-]{8,}\\b"; "s.<redacted>")
        | gsub("(?i)(\"?(password|secret|token|api_key|aws_secret_access_key|private_key|client_secret)\"?[[:space:]]*[:=][[:space:]]*\")([^\"\\r\\n]{4,})(\")"; "\\1<redacted>\\4")
        | gsub("(?i)(\"?(password|secret|token|api_key|aws_secret_access_key|private_key|client_secret)\"?[[:space:]]*[:=][[:space:]]*)([^[:space:]\",}{]{4,})"; "\\1<redacted>")
        | gsub("(?i)((cert|certificate|private[_-]?key|tls\\.crt|tls\\.key)[[:space:]]*[:=][[:space:]]*)([A-Za-z0-9+/=]{40,})"; "\\1<redacted-cert-data>")
        | gsub("[\r\n\t]+"; " ")
        | gsub("[[:space:]]+"; " ")
        | .[0:220]
      '
}

rewards_provider_should_collect_if_available() {
  local combined="${1:-}"
  if [[ "${HAS_LIB_REWARDS_PROVIDER_EVIDENCE:-0}" -eq 1 ]] && rewards_provider_should_collect "$combined"; then
    return 0
  fi
  return 1
}

collect_phase2_rewards_provider_context_if_available() {
  if [[ "${HAS_LIB_REWARDS_PROVIDER_EVIDENCE:-0}" -eq 1 ]]; then
    collect_phase2_rewards_provider_context
  fi
}

extract_image_tag() {
  local image="${1:-}"
  local image_no_digest ref_tail
  image_no_digest="${image%%@*}"
  ref_tail="${image_no_digest##*/}"
  if [[ "$ref_tail" == *:* ]]; then
    printf '%s\n' "${ref_tail##*:}"
  else
    printf '\n'
  fi
}

extract_commit_hint_from_tag() {
  local tag="${1:-}"
  if [[ -z "$tag" ]]; then
    printf '\n'
    return
  fi
  if [[ "$tag" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
    printf '%s\n' "$(printf '%s' "$tag" | tr '[:upper:]' '[:lower:]')"
    return
  fi
  printf '%s\n' "$tag" \
    | grep -Eo '[0-9a-fA-F]{7,40}' \
    | awk 'NF > 0 { print tolower($0) }' \
    | tail -n1 || true
}

count_tsv_in_namespaces() {
  local data="${1:-}"
  local namespaces_csv="${2:-}"
  local namespace_col="${3:-1}"
  if [[ -z "$data" || -z "$namespaces_csv" ]]; then
    printf '0\n'
    return
  fi
  printf '%s\n' "$data" | awk -F'\t' -v scopes="$namespaces_csv" -v col="$namespace_col" '
    BEGIN {
      n = split(scopes, parts, ",")
      for (i = 1; i <= n; i++) {
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", parts[i])
        if (parts[i] != "") {
          wanted[parts[i]] = 1
        }
      }
    }
    NF >= col && wanted[$col] { c++ }
    END { print c + 0 }
  '
}

compute_workload_hash8() {
  local workloads="${1:-}"
  local hash8
  hash8="$(printf '%s' "$workloads" | shasum -a 256 | awk '{print substr($1, 1, 8)}')"
  if [[ -z "$hash8" || "$hash8" == "e3b0c442" ]]; then
    hash8="empty000"
  fi
  printf '%s\n' "$hash8"
}

compute_dedup_key() {
  local namespace="${1:-unknown}"
  local category="${2:-unknown}"
  local workloads="${3:-}"
  local workload_hash8
  workload_hash8="$(compute_workload_hash8 "$workloads")"
  local minute half hour_bucket key_source
  minute="$(date -u +%M)"
  half=0
  if [[ "$minute" =~ ^[0-9]+$ ]] && ((10#$minute >= 30)); then
    half=30
  fi
  hour_bucket="$(date -u +%Y%m%d%H)$(printf '%02d' "$half")"
  key_source="${namespace}${category}${workload_hash8}${hour_bucket}"
  printf '%s' "$key_source" | shasum -a 256 | awk '{print $1}'
}

normalize_json_compact_or() {
  local raw="${1:-}"
  local fallback="${2:-null}"
  local compact
  if [[ -n "$raw" ]] && compact="$(printf '%s\n' "$raw" | jq -ce . 2>/dev/null)"; then
    printf '%s\n' "$compact"
    return 0
  fi
  [[ -n "$raw" ]] && echo "sentinel-triage:warn normalize_json_compact_or invalid JSON input; using fallback" >&2
  printf '%s\n' "$fallback" | jq -c .
}

normalize_json_number_or() {
  local raw="${1:-}"
  local fallback="${2:-0}"
  if [[ "$raw" =~ ^-?[0-9]+([.][0-9]+)?$ ]]; then
    printf '%s\n' "$raw"
    return 0
  fi
  [[ -n "$raw" ]] && echo "sentinel-triage:warn normalize_json_number_or invalid input; using fallback" >&2
  printf '%s\n' "$fallback"
}

apply_rca_confidence_cap() {
  local target_confidence="${1:-0}"
  local note="${2:-}"
  local updated_json fallback_json

  updated_json="$(
    printf '%s\n' "$rca_result_json" | jq -c --argjson confidence "$target_confidence" --arg note "$note" '
      .merged_confidence = $confidence
      | .degradation_note = (if (.degradation_note // "") == "" then $note else (.degradation_note + "; " + $note) end)
      | if (.hypotheses // [] | length) > 0 then .hypotheses[0].confidence = $confidence else . end
    ' 2>/dev/null || true
  )"
  if [[ -z "$updated_json" ]]; then
    log "RCA confidence cap jq mutation failed; attempting fallback patch"
    fallback_json="$(
      printf '%s\n' "$rca_result_json" | jq -c --argjson confidence "$target_confidence" --arg note "$note" '
        .merged_confidence = $confidence
        | .degradation_note = (if (.degradation_note // "") == "" then $note else (.degradation_note + "; " + $note) end)
      ' 2>/dev/null || true
    )"
    if [[ -n "$fallback_json" ]]; then
      updated_json="$fallback_json"
    else
      log "RCA confidence cap fallback patch failed; leaving RCA JSON unchanged"
    fi
  fi

  if [[ -n "$updated_json" ]]; then
    rca_result_json="$updated_json"
  else
    log "RCA confidence JSON mutation failed; forcing scalar confidence cap to ${target_confidence}"
  fi

  rca_confidence="$target_confidence"
  rca_degradation_note="$(
    sanitize_signal_line "$(
      printf '%s\n' "$rca_result_json" | jq -r '.degradation_note // empty' 2>/dev/null || printf '%s' "$note"
    )"
  )"
}

resolve_helper_script() {
  local script_name="$1"
  if [[ -x "${SCRIPT_DIR%/}/${script_name}" ]]; then
    printf '%s\n' "${SCRIPT_DIR%/}/${script_name}"
    return 0
  fi
  if [[ -x "${RCA_SCRIPT_DIR%/}/${script_name}" ]]; then
    printf '%s\n' "${RCA_SCRIPT_DIR%/}/${script_name}"
    return 0
  fi
  printf '\n'
}

sanitize_state_field() {
  local raw="${1:-}"
  if [[ -z "$raw" ]]; then
    printf '\n'
    return 0
  fi
  printf '%s\n' "$raw" \
    | sed -E 's/[^A-Za-z0-9_:.|,-]+/_/g; s/^_+|_+$//g; s/_{2,}/_/g'
}

normalize_pipe_atoms() {
  local raw="${1:-}"
  if [[ -z "$raw" ]]; then
    printf '\n'
    return 0
  fi
  printf '%s\n' "$raw" \
    | tr '|, ' '\n\n\n' \
    | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' \
    | awk 'NF > 0 { print }' \
    | sort -u \
    | paste -sd'|' -
}

pipe_atom_sets_intersect() {
  local left="${1:-}"
  local right="${2:-}"
  local normalized_left normalized_right atom

  normalized_left="$(normalize_pipe_atoms "$left")"
  normalized_right="$(normalize_pipe_atoms "$right")"
  [[ -n "$normalized_left" && -n "$normalized_right" ]] || return 1

  while IFS= read -r atom; do
    [[ -n "$atom" ]] || continue
    if [[ "|$normalized_left|" == *"|$atom|"* ]]; then
      return 0
    fi
  done < <(printf '%s\n' "$normalized_right" | tr '|' '\n')

  return 1
}

normalize_csv_atoms() {
  local raw="${1:-}"
  if [[ -z "$raw" ]]; then
    printf '\n'
    return 0
  fi
  printf '%s\n' "$raw" \
    | tr '|, ' '\n\n\n' \
    | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' \
    | awk 'NF > 0 { print }' \
    | sort -u \
    | paste -sd',' -
}

split_csv_atoms() {
  local raw="${1:-}"
  if [[ -z "$raw" ]]; then
    return 0
  fi
  printf '%s\n' "$raw" \
    | tr ',' '\n' \
    | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' \
    | awk 'NF > 0 { print }'
}

normalize_pod_workload_name() {
  local pod_name="${1:-}"
  if [[ -z "$pod_name" ]]; then
    printf '\n'
    return 0
  fi
  printf '%s\n' "$pod_name" \
    | sed -E 's/-[a-z0-9]{5}$//; s/-[a-f0-9]{8,10}$//'
}

derive_step11_workloads() {
  local deploy_rows_input="${1:-}"
  local pod_rows_input="${2:-}"
  local raw_workloads
  raw_workloads="$(
    {
      printf '%s\n' "$deploy_rows_input" | awk -F'\t' 'NF >= 2 { print $2 }'
      while IFS=$'\t' read -r _ns pod_name _rest; do
        [[ -z "${pod_name:-}" ]] && continue
        normalize_pod_workload_name "$pod_name"
      done < <(printf '%s\n' "$pod_rows_input")
    } | awk 'NF > 0 { print }'
  )"
  normalize_pipe_atoms "$raw_workloads"
}

tsv_field() {
  local row="${1:-}"
  local index="${2:-1}"
  printf '%s\n' "$row" | awk -F'\t' -v idx="$index" 'NR == 1 { print $idx }'
}

fallback_incident_id() {
  local namespace="${1:-unknown}"
  local category="${2:-unknown}"
  local workloads="${3:-}"
  local fingerprint="${4:-0}"
  local wl_hash
  wl_hash="$(compute_workload_hash8 "$workloads")"
  printf 'hb:%s:%s:fp%s:%s\n' \
    "$(sanitize_state_field "$namespace")" \
    "$(sanitize_state_field "$category")" \
    "$(sanitize_state_field "$fingerprint")" \
    "$(sanitize_state_field "$wl_hash")"
}

resolve_rca_mode() {
  local mode
  mode="$(printf '%s' "${RCA_MODE:-single}" | tr '[:upper:]' '[:lower:]')"
  case "$mode" in
    single|dual|heuristic)
      printf '%s\n' "$mode"
      ;;
    *)
      printf 'heuristic\n'
      ;;
  esac
}

mark_evidence_step() {
  local step_num="$1"
  local applicable="${2:-1}"
  if [[ "$applicable" != "1" ]]; then
    return 0
  fi
  evidence_applicable_steps=$((evidence_applicable_steps + 1))
  local status_var="STEP_STATUS_${step_num}"
  if [[ "${!status_var:-}" == "ok" ]]; then
    evidence_completed_steps=$((evidence_completed_steps + 1))
  fi
}

source_optional_lib() {
  local lib_name="$1"
  local flag_name="$2"
  local lib_path="${SCRIPT_DIR%/}/${lib_name}.sh"
  local alt_lib_path="${RCA_SCRIPT_DIR%/}/${lib_name}.sh"
  printf -v "$flag_name" '%s' "0"
  if [[ -f "$alt_lib_path" ]]; then
    # shellcheck source=/dev/null
    source "$alt_lib_path"
    printf -v "$flag_name" '%s' "1"
    return 0
  fi
  if [[ -f "$lib_path" ]]; then
    # shellcheck source=/dev/null
    source "$lib_path"
    printf -v "$flag_name" '%s' "1"
    return 0
  fi
}

cleanup_spool() {
  local now ttl max_files
  now="$(date +%s 2>/dev/null || echo 0)"
  ttl=86400
  max_files=100
  mkdir -p "$SPOOL_DIR" 2>/dev/null || true
  if [[ ! -d "$SPOOL_DIR" ]]; then
    return 0
  fi

  find "$SPOOL_DIR" -maxdepth 1 -type f \( -name "*.ack" -o -name "*.acked" -o -name "*.done" -o -name ".cron-healthcheck-*" \) -mmin +1440 -delete 2>/dev/null || true

  local file mtime age
  while IFS= read -r -d '' file; do
    mtime="$(stat -f %m "$file" 2>/dev/null || true)"
    if ! [[ "$mtime" =~ ^[0-9]+$ ]]; then
      mtime="$(stat -c %Y "$file" 2>/dev/null || true)"
    fi
    if ! [[ "$mtime" =~ ^[0-9]+$ ]]; then
      mtime="$now"
    fi
    age=$((now - mtime))
    if ((age > ttl)); then
      mv "$file" "${file}.dead" 2>/dev/null || true
    fi
  done < <(find "$SPOOL_DIR" -maxdepth 1 -type f -name "triage-*.json" -print0 2>/dev/null)

  local count
  count="$(find "$SPOOL_DIR" -maxdepth 1 -type f -name "triage-*.json" | wc -l | tr -d ' ')"
  if [[ "$count" =~ ^[0-9]+$ ]] && ((count > max_files)); then
    local trim_count
    trim_count=$((count - max_files))
    find "$SPOOL_DIR" -maxdepth 1 -type f -name "triage-*.json" -print \
      | sort \
      | head -n "$trim_count" \
      | while IFS= read -r file; do
          mv "$file" "${file}.dead" 2>/dev/null || true
        done
  fi
}

coalesce_spool_for_key() {
  local key="$1"
  local latest=""
  local file
  while IFS= read -r file; do
    latest="$file"
  done < <(find "$SPOOL_DIR" -maxdepth 1 -type f -name "triage-${key}-*.json" | sort)

  if [[ -z "$latest" ]]; then
    printf '\n'
    return 1
  fi

  while IFS= read -r file; do
    [[ "$file" == "$latest" ]] && continue
    mv "$file" "${file}.acked" 2>/dev/null || true
  done < <(find "$SPOOL_DIR" -maxdepth 1 -type f -name "triage-${key}-*.json" | sort)

  printf '%s\n' "$latest"
}

fsync_file() {
  local file="$1"
  sync "$file" 2>/dev/null || sync 2>/dev/null || true
}

LEASE_DIR=""

acquire_lease() {
  local key="$1"
  local lease_path="${SPOOL_DIR}/lease-${key}"
  local done_marker="${SPOOL_DIR}/${key}.done"

  if [[ -f "$done_marker" ]]; then
    log "Lease: .done exists for key=${key}, skipping"
    return 1
  fi

  if mkdir "$lease_path" 2>/dev/null; then
    printf '%s:%s\n' "$(hostname 2>/dev/null || echo unknown-host)" "$(date +%s 2>/dev/null || echo 0)" > "${lease_path}/owner"
    LEASE_DIR="$lease_path"
    return 0
  fi

  if [[ -f "${lease_path}/owner" ]]; then
    local owner_ts now
    owner_ts="$(cut -d: -f2 "${lease_path}/owner" 2>/dev/null || echo 0)"
    now="$(date +%s 2>/dev/null || echo 0)"
    if [[ "$owner_ts" =~ ^[0-9]+$ ]] && [[ "$now" =~ ^[0-9]+$ ]] && ((now - owner_ts > STEP_LEASE_TTL_SECONDS)); then
      log "Lease: reclaim stale lease key=${key} age=$((now - owner_ts))s"
      rm -f "${lease_path}/owner"
      rmdir "$lease_path" 2>/dev/null || true
      if mkdir "$lease_path" 2>/dev/null; then
        printf '%s:%s\n' "$(hostname 2>/dev/null || echo unknown-host)" "$(date +%s 2>/dev/null || echo 0)" > "${lease_path}/owner"
        LEASE_DIR="$lease_path"
        return 0
      fi
    fi
  fi

  log "Lease: already owned for key=${key}, skip Step 11"
  return 1
}

release_lease() {
  local key="$1"
  local lease_path="${SPOOL_DIR}/lease-${key}"
  touch "${SPOOL_DIR}/${key}.done" 2>/dev/null || true
  rm -f "${lease_path}/owner"
  rmdir "$lease_path" 2>/dev/null || true
  LEASE_DIR=""
}

abandon_lease() {
  local key="$1"
  local lease_path="${SPOOL_DIR}/lease-${key}"
  rm -f "${lease_path}/owner"
  rmdir "$lease_path" 2>/dev/null || true
  LEASE_DIR=""
}

write_spool_payload() {
  local key="$1"
  local payload="$2"
  local now_ts spool_file
  now_ts="$(date -u +%Y%m%dT%H%M%SZ)"
  spool_file="${SPOOL_DIR}/triage-${key}-${now_ts}.json"
  printf '%s\n' "$payload" > "$spool_file"
  fsync_file "$spool_file"
  printf '%s\n' "$spool_file"
}

redact_payload_for_sink() {
  local payload="$1"
  local sink="$2"
  if [[ "${HAS_LIB_RCA_SINK:-0}" -eq 1 ]] && declare -F redact_for_sink >/dev/null 2>&1; then
    redact_for_sink "$payload" "$sink"
    return $?
  fi
  printf '%s\n' "$payload"
}

rca_cache_file_for_incident() {
  local incident_id="${1:-}"
  if [[ -z "$incident_id" ]]; then
    return 1
  fi
  local cache_key
  cache_key="$(printf '%s' "$incident_id" | shasum -a 256 | awk '{print $1}')"
  printf '%s\n' "${INCIDENT_STATE_DIR%/}/rca-cache-${cache_key}.json"
}

rca_cache_read_json() {
  local incident_id="${1:-}"
  local cache_file
  cache_file="$(rca_cache_file_for_incident "$incident_id" 2>/dev/null || true)"
  [[ -n "$cache_file" && -s "$cache_file" ]] || return 1
  if ! jq -e . "$cache_file" >/dev/null 2>&1; then
    return 1
  fi
  cat "$cache_file"
}

rca_cache_write_json() {
  local incident_id="${1:-}"
  local evidence_fingerprint="${2:-}"
  local last_rca_ts="${3:-0}"
  local rca_json="${4:-}"
  [[ -n "$incident_id" && -n "$rca_json" ]] || return 1
  if ! printf '%s\n' "$rca_json" | jq -e . >/dev/null 2>&1; then
    return 1
  fi

  local cache_file cache_dir tmp_file payload
  cache_file="$(rca_cache_file_for_incident "$incident_id" 2>/dev/null || true)"
  [[ -n "$cache_file" ]] || return 1
  cache_dir="${cache_file%/*}"
  mkdir -p "$cache_dir" 2>/dev/null || return 1

  payload="$(jq -cn \
    --arg incident_id "$incident_id" \
    --arg evidence_fingerprint "$evidence_fingerprint" \
    --arg last_rca_ts "$last_rca_ts" \
    --argjson rca_result_json "$(normalize_json_compact_or "$rca_json" '{}')" \
    '{
      incident_id: $incident_id,
      evidence_fingerprint: $evidence_fingerprint,
      last_rca_ts: ($last_rca_ts | tonumber? // 0),
      rca_result_json: $rca_result_json
    }')"

  tmp_file="${cache_file}.tmp.$$"
  printf '%s\n' "$payload" >"$tmp_file"
  mv -f "$tmp_file" "$cache_file"
}

rca_cache_get_field() {
  local incident_id="${1:-}"
  local jq_expr="$2"
  local fallback="${3:-}"
  local json
  json="$(rca_cache_read_json "$incident_id" 2>/dev/null || true)"
  if [[ -z "$json" ]]; then
    printf '%s\n' "$fallback"
    return 0
  fi
  printf '%s\n' "$json" | jq -r "$jq_expr" 2>/dev/null || printf '%s\n' "$fallback"
}

emit_abort_output() {
  local reason="$1"
  local abort_step_num="${2:-}"
  section "meta"
  printf 'snapshot_utc\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'context\t%s\n' "$K8S_CONTEXT"
  printf 'namespace_scope\t%s\n' "${SCOPE_NAMESPACES:-all}"
  section "health_status"
  printf 'state\tincident\n'
  printf 'incident_signals\t0\n'
  section "incident_gate"
  printf 'should_alert\tno\n'
  printf 'gate_reason\tinsufficient-core-signals\n'
  section "step_status"
  printf 'step\tstatus\tlatency_ms\n'
  local step_num status_var latency_var
  local preflight_failure_command="${PREFLIGHT_FAILURE_COMMAND:-}"
  local preflight_failure_error="${PREFLIGHT_FAILURE_ERROR:-}"
  for step_num in 00 01 02 03 04 05 06 07 08 09 10 11; do
    status_var="STEP_STATUS_${step_num}"
    latency_var="STEP_LATENCY_${step_num}"
    printf '%s\t%s\t%s\n' "$step_num" "${!status_var:-skipped}" "${!latency_var:-0}"
  done
  section "blocked_evidence"
  if [[ -n "$preflight_failure_command" ]]; then
    printf 'command\t%s\n' "$preflight_failure_command"
    printf 'exit_code\t%s\n' "${PREFLIGHT_FAILURE_EXIT_CODE:-1}"
    printf 'error\t%s\n' "$preflight_failure_error"
  elif [[ -n "$abort_step_num" ]]; then
    local output_var="STEP_OUTPUT_${abort_step_num}"
    printf 'command\t%s\n' "step_${abort_step_num}"
    if [[ -n "${!output_var:-}" ]]; then
      printf 'output\t%s\n' "$(sanitize_signal_line "${!output_var}")"
    fi
  fi
  section "abort_reason"
  printf 'reason\t%s\n' "$reason"
}

step_01_pod_deploy() {
  local pods_json_local deploys_json_local
  local pods_output_local deploys_output_local
  local pod_rows_local container_state_rows_local deploy_rows_local

  pods_output_local="$(run_with_timeout "$KUBECTL_TIMEOUT" kctl get pods -A -o json 2>&1)" || {
    emit_step_var "STEP_FAILURE_COMMAND_01" 'kubectl --context "$K8S_CONTEXT" get pods -A -o json'
    printf '__STEP_FAILURE_COMMAND__\t%s\n' 'kubectl --context "$K8S_CONTEXT" get pods -A -o json' >&2
    printf '%s\n' "$pods_output_local" >&2
    return 1
  }
  deploys_output_local="$(run_with_timeout "$KUBECTL_TIMEOUT" kctl get deploy -A -o json 2>&1)" || {
    emit_step_var "STEP_FAILURE_COMMAND_01" 'kubectl --context "$K8S_CONTEXT" get deploy -A -o json'
    printf '__STEP_FAILURE_COMMAND__\t%s\n' 'kubectl --context "$K8S_CONTEXT" get deploy -A -o json' >&2
    printf '%s\n' "$deploys_output_local" >&2
    return 1
  }
  pods_json_local="$pods_output_local"
  deploys_json_local="$deploys_output_local"

  pod_rows_local="$(
    printf '%s\n' "$pods_json_local" | jq -r \
      --argjson scopes "$NS_FILTER_JSON" \
      --argjson restartThreshold "$RESTART_THRESHOLD" '
      .items[]
      | .metadata.namespace as $ns
      | select(($scopes | length) == 0 or ($scopes | index($ns) != null))
      | .metadata.name as $pod
      | (.status.phase // "Unknown") as $phase
      | ([.status.containerStatuses[]?, .status.initContainerStatuses[]?] | map(.restartCount // 0) | add // 0) as $restarts
      | (
          [.status.containerStatuses[]?, .status.initContainerStatuses[]?]
          | map(
              if (.state.waiting.reason? // "") != "" then .state.waiting.reason
              elif (.state.terminated.reason? // "") != "" and (.state.terminated.reason != "Completed") then .state.terminated.reason
              else empty end
            )
          | unique
          | join(",")
        ) as $reasons
      | select(
          ($phase != "Running" and $phase != "Succeeded")
          or ($restarts >= $restartThreshold)
          or ($reasons != "")
        )
      | [$ns, $pod, $phase, ($restarts | tostring), (if $reasons == "" then "-" else $reasons end)]
      | @tsv
    ' | sort
  )" || pod_rows_local=""

  container_state_rows_local="$(
    printf '%s\n' "$pods_json_local" | jq -r \
      --argjson scopes "$NS_FILTER_JSON" \
      --argjson restartThreshold "$RESTART_THRESHOLD" '
      .items[]
      | .metadata.namespace as $ns
      | select(($scopes | length) == 0 or ($scopes | index($ns) != null))
      | .metadata.name as $pod
      | [(.status.containerStatuses[]? | . + {kind: "container"}), (.status.initContainerStatuses[]? | . + {kind: "init"})]
      | .[]
      | .name as $container
      | (.kind // "container") as $kind
      | (.restartCount // 0) as $restarts
      | (.state.waiting.reason // "") as $waitingReason
      | (.state.waiting.message // "") as $waitingMessage
      | (.state.terminated.reason // "") as $terminatedReason
      | (.state.terminated.message // "") as $terminatedMessage
      | (.state.terminated.exitCode // .lastState.terminated.exitCode // -1) as $exitCode
      | (.lastState.terminated.reason // "") as $lastTerminatedReason
      | (.lastState.terminated.message // "") as $lastTerminatedMessage
      | (
          if $waitingReason != "" then "waiting"
          elif $terminatedReason != "" then "terminated"
          elif $lastTerminatedReason != "" then "lastTerminated"
          else "running"
          end
        ) as $stateType
      | (
          if $waitingReason != "" then $waitingReason
          elif $terminatedReason != "" then $terminatedReason
          elif $lastTerminatedReason != "" then $lastTerminatedReason
          else ""
          end
        ) as $rawReason
      | (
          if $stateType == "terminated" and $rawReason == "Completed" then ""
          else $rawReason
          end
        ) as $reason
      | (
          if $waitingMessage != "" then $waitingMessage
          elif $terminatedMessage != "" then $terminatedMessage
          elif $lastTerminatedMessage != "" then $lastTerminatedMessage
          else ""
          end
        ) as $message
      | select(
          ($stateType != "running" and ($reason != "" or $message != ""))
          or ($restarts >= $restartThreshold and $reason != "Completed")
          or ($reason == "OOMKilled")
        )
      | [
          $ns,
          $pod,
          $container,
          $kind,
          ($restarts | tostring),
          $stateType,
          (if $reason == "" then "-" else $reason end),
          (if $exitCode == -1 then "-" else ($exitCode | tostring) end),
          (
            if $message == "" then "-"
            else
              (
                $message
                | gsub("(?i)(authorization:[[:space:]]*bearer[[:space:]]+)[A-Za-z0-9._=-]+"; "\\1<redacted>")
                | gsub("(?i)(xox[baprs]-)[A-Za-z0-9-]+"; "\\1<redacted>")
                | gsub("(?i)(xapp-[0-9]+-)[A-Za-z0-9-]+"; "\\1<redacted>")
                | gsub("(?i)(gh[pousr]_[A-Za-z0-9_]+)"; "<redacted-gh-token>")
                | gsub("(?i)github_pat_[A-Za-z0-9_]+"; "<redacted-gh-token>")
                | gsub("AKIA[0-9A-Z]{16}"; "<redacted-aws-key>")
                | gsub("ASIA[0-9A-Z]{16}"; "<redacted-aws-sts-key>")
                | gsub("[\r\n\t]+"; " ")
                | .[0:220]
              )
            end
          )
        ]
      | @tsv
    ' | sort -u
  )" || container_state_rows_local=""

  deploy_rows_local="$(
    printf '%s\n' "$deploys_json_local" | jq -r --argjson scopes "$NS_FILTER_JSON" '
      .items[]
      | .metadata.namespace as $ns
      | select(($scopes | length) == 0 or ($scopes | index($ns) != null))
      | .metadata.name as $name
      | (.spec.replicas // 1) as $desired
      | (.status.availableReplicas // 0) as $available
      | (.status.updatedReplicas // 0) as $updated
      | (.status.unavailableReplicas // 0) as $unavailable
      | select(($available < $desired) or ($unavailable > 0))
      | [$ns, $name, ($desired | tostring), ($available | tostring), ($updated | tostring), ($unavailable | tostring)]
      | @tsv
    ' | sort
  )" || deploy_rows_local=""

  emit_step_var "pod_rows" "$pod_rows_local"
  emit_step_var "container_state_rows" "$container_state_rows_local"
  emit_step_var "deploy_rows" "$deploy_rows_local"
}

step_02_events_alerts() {
  local events_json_local alerts_json_local event_rows_local alert_rows_local
  local events_output_local alerts_output_local

  events_output_local="$(run_with_timeout "$KUBECTL_TIMEOUT" kctl get events -A -o json 2>&1)" || {
    emit_step_var "STEP_FAILURE_COMMAND_02" 'kubectl --context "$K8S_CONTEXT" get events -A -o json'
    printf '__STEP_FAILURE_COMMAND__\t%s\n' 'kubectl --context "$K8S_CONTEXT" get events -A -o json' >&2
    printf '%s\n' "$events_output_local" >&2
    return 1
  }
  alerts_output_local="$(
    if command -v curl >/dev/null 2>&1; then
      run_with_timeout "${PROMETHEUS_TIMEOUT_SECONDS}s" \
        curl -fsS "${PROMETHEUS_URL}/api/v1/alerts" 2>&1
    else
      printf 'curl missing\n'
      false
    fi
  )" || alerts_output_local='{"status":"error","data":{"alerts":[]}}'
  events_json_local="$events_output_local"
  alerts_json_local="$alerts_output_local"

  event_rows_local="$(
    printf '%s\n' "$events_json_local" | jq -r --argjson scopes "$NS_FILTER_JSON" '
      .items
      | map(.metadata.namespace as $ns | select(($scopes | length) == 0 or ($scopes | index($ns) != null)))
      | map(select((.type // "Normal") != "Normal"))
      | sort_by(.eventTime // .lastTimestamp // .metadata.creationTimestamp // .firstTimestamp // "")
      | .[]
      | [
          (.metadata.namespace // "-"),
          ((.involvedObject.kind // "-") + "/" + (.involvedObject.name // "-")),
          (.reason // "-"),
          (.eventTime // .lastTimestamp // .metadata.creationTimestamp // .firstTimestamp // "-"),
          (
            (.message // "-")
            | gsub("(?i)(authorization:[[:space:]]*bearer[[:space:]]+)[A-Za-z0-9._=-]+"; "\\1<redacted>")
            | gsub("(?i)(xox[baprs]-)[A-Za-z0-9-]+"; "\\1<redacted>")
            | gsub("(?i)(xapp-[0-9]+-)[A-Za-z0-9-]+"; "\\1<redacted>")
            | gsub("(?i)(gh[pousr]_[A-Za-z0-9_]+)"; "<redacted-gh-token>")
            | gsub("(?i)github_pat_[A-Za-z0-9_]+"; "<redacted-gh-token>")
            | gsub("AKIA[0-9A-Z]{16}"; "<redacted-aws-key>")
            | gsub("ASIA[0-9A-Z]{16}"; "<redacted-aws-sts-key>")
            | gsub("[\r\n\t]+"; " ")
            | .[0:220]
          )
        ]
      | @tsv
    '
  )" || event_rows_local=""

  alert_rows_local="$(
    printf '%s\n' "$alerts_json_local" | jq -r --argjson ignored "$IGNORE_ALERTS_JSON" '
      if .status != "success" then
        empty
      else
        .data.alerts[]
        | select(.state == "firing")
        | (.labels.alertname // "") as $alertName
        | select(($ignored | index($alertName)) == null)
        | [
            (.labels.severity // "-"),
            (.labels.alertname // "-"),
            (.labels.namespace // "-"),
            (.labels.pod // "-"),
            (.labels.job // "-"),
            (.activeAt // "-")
          ]
        | @tsv
      end
    ' | sort
  )" || alert_rows_local=""

  emit_step_var "event_rows" "$event_rows_local"
  emit_step_var "alert_rows" "$alert_rows_local"
}

step_00_linear_memory() {
  local linear_script output_local
  local linear_query_local linear_limit_local
  local linear_memory_status_local linear_memory_rows_count_local linear_memory_note_local
  local linear_memory_output_local

  linear_script="$(resolve_helper_script "linear-memory-lookup.sh")"
  linear_query_local="${LINEAR_MEMORY_QUERY:-${SCOPE_NAMESPACES}}"
  linear_limit_local="${LINEAR_MEMORY_LIMIT:-5}"

  if [[ -z "$linear_script" ]]; then
    emit_step_var "linear_memory_status" "skipped"
    emit_step_var "linear_memory_rows_count" "0"
    emit_step_var "linear_memory_note" "script_missing"
    emit_step_var "linear_memory_output" ""
    return 0
  fi

  output_local="$(
    bash "$linear_script" --query "$linear_query_local" --limit "$linear_limit_local" 2>/dev/null || true
  )"

  linear_memory_status_local="$(printf '%s\n' "$output_local" | awk -F'\t' '$1=="status" {print $2; exit}')"
  linear_memory_rows_count_local="$(printf '%s\n' "$output_local" | awk -F'\t' '$1=="status" {print $3; exit}')"
  linear_memory_note_local="$(printf '%s\n' "$output_local" | awk -F'\t' '$1=="status" {print $3; exit}')"
  linear_memory_output_local="$(printf '%s\n' "$output_local" | awk 'NR > 1 { print }')"

  if [[ -z "$linear_memory_status_local" ]]; then
    linear_memory_status_local="skipped"
  fi

  if ! [[ "$linear_memory_rows_count_local" =~ ^[0-9]+$ ]]; then
    linear_memory_rows_count_local="$(printf '%s\n' "$linear_memory_output_local" | awk 'NR > 1 && NF > 0 { c++ } END { print c + 0 }')"
  fi

  if [[ -z "$linear_memory_note_local" ]]; then
    linear_memory_note_local="none"
  fi

  emit_step_var "linear_memory_status" "$linear_memory_status_local"
  emit_step_var "linear_memory_rows_count" "$linear_memory_rows_count_local"
  emit_step_var "linear_memory_note" "$linear_memory_note_local"
  emit_step_var "linear_memory_output" "$linear_memory_output_local"
}

step_03_prometheus_trends() {
  local trends_script output_local
  local prom_critical_local prom_warning_local prom_note_local

  trends_script="$(resolve_helper_script "prometheus-trends.sh")"
  if [[ -z "$trends_script" ]]; then
    emit_step_var "prom_trend_critical_count" "0"
    emit_step_var "prom_trend_warning_count" "0"
    emit_step_var "prom_trend_note" "script_missing"
    return 0
  fi

  output_local="$(bash "$trends_script" 2>/dev/null || true)"
  prom_critical_local="$(printf '%s\n' "$output_local" | awk -F'\t' 'NR > 1 && tolower($7) == "critical" { c++ } END { print c + 0 }')"
  prom_warning_local="$(printf '%s\n' "$output_local" | awk -F'\t' 'NR > 1 && tolower($7) == "warning" { c++ } END { print c + 0 }')"
  prom_note_local="none"
  if [[ -z "$output_local" ]]; then
    prom_note_local="empty_output"
  fi

  emit_step_var "prom_trend_critical_count" "$prom_critical_local"
  emit_step_var "prom_trend_warning_count" "$prom_warning_local"
  emit_step_var "prom_trend_note" "$prom_note_local"
  printf '%s\n' "$output_local"
}

step_04_argocd_sync() {
  local argocd_script output_local argocd_evidence_file
  local argocd_critical_local argocd_warning_local argocd_note_local

  argocd_script="$(resolve_helper_script "argocd-sync-status.sh")"
  if [[ -z "$argocd_script" ]]; then
    emit_step_var "argocd_critical_count" "0"
    emit_step_var "argocd_warning_count" "0"
    emit_step_var "argocd_note" "script_missing"
    return 0
  fi

  argocd_evidence_file="$(mktemp "${TMPDIR:-/tmp}/openclaw-argocd-evidence.XXXXXX")"
  output_local="$(ARGOCD_SYNC_EVIDENCE_FILE="$argocd_evidence_file" bash "$argocd_script" 2>/dev/null || true)"
  argocd_critical_local="$(printf '%s\n' "$output_local" | awk -F'\t' 'NR > 1 && tolower($6) ~ /severity=critical/ { c++ } END { print c + 0 }')"
  argocd_warning_local="$(printf '%s\n' "$output_local" | awk -F'\t' 'NR > 1 && tolower($6) ~ /severity=warning/ { c++ } END { print c + 0 }')"
  argocd_drift_evidence_output="$(cat "$argocd_evidence_file" 2>/dev/null || true)"
  rm -f "$argocd_evidence_file" >/dev/null 2>&1 || true
  argocd_note_local="none"
  if [[ -z "$output_local" ]]; then
    argocd_note_local="empty_output"
  fi

  emit_step_var "argocd_critical_count" "$argocd_critical_local"
  emit_step_var "argocd_warning_count" "$argocd_warning_local"
  emit_step_var "argocd_note" "$argocd_note_local"
  printf '%s\n' "$output_local"
}

step_06_cert_secret_health() {
  local cert_script output_local
  local cert_critical_local cert_warning_local cert_note_local

  cert_script="$(resolve_helper_script "cert-secret-health.sh")"
  if [[ -z "$cert_script" ]]; then
    emit_step_var "cert_health_critical_count" "0"
    emit_step_var "cert_health_warning_count" "0"
    emit_step_var "cert_health_note" "script_missing"
    return 0
  fi

  output_local="$(bash "$cert_script" 2>/dev/null || true)"
  cert_critical_local="$(printf '%s\n' "$output_local" | awk -F'\t' 'NR > 1 && tolower($6) == "critical" { c++ } END { print c + 0 }')"
  cert_warning_local="$(printf '%s\n' "$output_local" | awk -F'\t' 'NR > 1 && tolower($6) == "warning" { c++ } END { print c + 0 }')"
  cert_note_local="none"
  if [[ -z "$output_local" ]]; then
    cert_note_local="empty_output"
  fi

  emit_step_var "cert_health_critical_count" "$cert_critical_local"
  emit_step_var "cert_health_warning_count" "$cert_warning_local"
  emit_step_var "cert_health_note" "$cert_note_local"
  printf '%s\n' "$output_local"
}

step_07_aws_resource_signals() {
  local aws_script output_local
  local aws_critical_local aws_warning_local aws_note_local

  aws_script="$(resolve_helper_script "aws-resource-signals.sh")"
  if [[ -z "$aws_script" ]]; then
    emit_step_var "aws_signal_critical_count" "0"
    emit_step_var "aws_signal_warning_count" "0"
    emit_step_var "aws_signal_note" "script_missing"
    return 0
  fi

  output_local="$(bash "$aws_script" 2>/dev/null || true)"
  aws_critical_local="$(printf '%s\n' "$output_local" | awk -F'\t' 'NR > 1 && tolower($3) == "critical" { c++ } END { print c + 0 }')"
  aws_warning_local="$(printf '%s\n' "$output_local" | awk -F'\t' 'NR > 1 && tolower($3) == "warning" { c++ } END { print c + 0 }')"
  aws_note_local="none"
  if [[ -z "$output_local" ]]; then
    aws_note_local="empty_output"
  fi

  emit_step_var "aws_signal_critical_count" "$aws_critical_local"
  emit_step_var "aws_signal_warning_count" "$aws_warning_local"
  emit_step_var "aws_signal_note" "$aws_note_local"
  printf '%s\n' "$output_local"
}

step_05_log_signals() {
  local container_rows_local
  container_rows_local="${container_state_rows:-}"
  local log_signal_rows_local="" target_count per_container_count
  local ns pod container _kind _restarts _state _reason _exit_code _message
  local current_logs raw_line sanitized_line signal_kind lower_line
  local log_signal_count_local log_authz_count_local log_network_count_local
  local log_tls_count_local log_crash_count_local log_oom_count_local

  if [[ "$INCLUDE_LOG_SNIPPETS" == "1" && -n "$container_rows_local" ]]; then
    target_count=0
    while IFS=$'\t' read -r ns pod container _kind _restarts _state _reason _exit_code _message; do
      [[ -z "${ns:-}" || -z "${pod:-}" || -z "${container:-}" ]] && continue
      if [[ "$target_count" -ge "$LOG_SNIPPET_PODS_LIMIT" ]]; then
        break
      fi

      current_logs="$(
        run_with_timeout "$KUBECTL_TIMEOUT" \
          kctl -n "$ns" logs "$pod" -c "$container" --tail="$LOG_SNIPPET_LINES" 2>/dev/null || true
      )"
      if [[ -z "$current_logs" ]]; then
        current_logs="$(
          run_with_timeout "$KUBECTL_TIMEOUT" \
            kctl -n "$ns" logs "$pod" -c "$container" --previous --tail="$LOG_SNIPPET_LINES" 2>/dev/null || true
        )"
      fi
      [[ -z "$current_logs" ]] && continue

      per_container_count=0
      while IFS= read -r raw_line; do
        [[ -z "${raw_line:-}" ]] && continue
        sanitized_line="$(sanitize_signal_line "$raw_line")"
        [[ -z "${sanitized_line:-}" ]] && continue
        signal_kind="runtime-error"
        lower_line="$(printf '%s' "$sanitized_line" | tr '[:upper:]' '[:lower:]')"
        case "$lower_line" in
          *oom*|*"out of memory"*)
            signal_kind="oom"
            ;;
          *"connection refused"*|*"no route to host"*|*"dial tcp"*|*"i/o timeout"*|*timeout*)
            signal_kind="network"
            ;;
          *forbidden*|*"permission denied"*|*unauthorized*|*"access denied"*)
            signal_kind="authz"
            ;;
          *x509*|*tls*|*certificate*)
            signal_kind="tls"
            ;;
          *panic*|*traceback*|*exception*|*"segmentation fault"*)
            signal_kind="crash"
            ;;
        esac
        log_signal_rows_local="${log_signal_rows_local}${ns}"$'\t'"${pod}"$'\t'"${container}"$'\t'"${signal_kind}"$'\t'"${sanitized_line}"$'\n'
        per_container_count=$((per_container_count + 1))
        if [[ "$per_container_count" -ge "$LOG_SNIPPET_ERRORS_PER_CONTAINER" ]]; then
          break
        fi
      done < <(
        printf '%s\n' "$current_logs" | awk '
          BEGIN { IGNORECASE=1 }
          /(error|fatal|panic|exception|traceback|oom|out of memory|backoff|connection refused|no route to host|dial tcp|i\/o timeout|timeout|denied|forbidden|x509|segmentation fault|failed)/ { print }
        '
      )

      if [[ "$per_container_count" -gt 0 ]]; then
        target_count=$((target_count + 1))
      fi
    done < <(printf '%s\n' "$container_rows_local")
  fi

  log_signal_rows_local="$(printf '%s' "$log_signal_rows_local" | awk 'NF > 0 { print }' | sort -u)" || log_signal_rows_local=""
  log_signal_count_local="$(count_lines "$log_signal_rows_local")"
  log_authz_count_local="$(printf '%s\n' "$log_signal_rows_local" | awk -F'\t' '$4 == "authz" { c++ } END { print c + 0 }')"
  log_network_count_local="$(printf '%s\n' "$log_signal_rows_local" | awk -F'\t' '$4 == "network" { c++ } END { print c + 0 }')"
  log_tls_count_local="$(printf '%s\n' "$log_signal_rows_local" | awk -F'\t' '$4 == "tls" { c++ } END { print c + 0 }')"
  log_crash_count_local="$(printf '%s\n' "$log_signal_rows_local" | awk -F'\t' '$4 == "crash" { c++ } END { print c + 0 }')"
  log_oom_count_local="$(printf '%s\n' "$log_signal_rows_local" | awk -F'\t' '$4 == "oom" { c++ } END { print c + 0 }')"

  emit_step_var "log_signal_rows" "$log_signal_rows_local"
  emit_step_var "log_signal_count" "$log_signal_count_local"
  emit_step_var "log_authz_count" "$log_authz_count_local"
  emit_step_var "log_network_count" "$log_network_count_local"
  emit_step_var "log_tls_count" "$log_tls_count_local"
  emit_step_var "log_crash_count" "$log_crash_count_local"
  emit_step_var "log_oom_count" "$log_oom_count_local"
}

step_08_image_repo() {
  local pod_rows_local impacted_pod_keys_local
  local repo_map_rows_local="" repo_map_note_local=""
  local image_repo_map_script workload_repo_map_file
  pod_rows_local="${pod_rows:-}"

  impacted_pod_keys_local="$(
    printf '%s\n' "$pod_rows_local" \
      | awk -F'\t' 'NF >= 2 { print $1 "\t" $2 }' \
      | sort -u
  )" || impacted_pod_keys_local=""

  if [[ "$INCLUDE_REPO_MAP" == "1" ]]; then
    image_repo_map_script="${RCA_SCRIPT_DIR%/}/image-repo-map.sh"
    workload_repo_map_file="/tmp/openclaw-image-repo/workload-image-repo.tsv"
    if [[ ! -f "$image_repo_map_script" ]]; then
      repo_map_note_local="image repo map script missing: ${image_repo_map_script}"
    elif [[ -z "$impacted_pod_keys_local" ]]; then
      repo_map_note_local="no impacted pods to map"
    elif bash "$image_repo_map_script" >/dev/null 2>&1 && [[ -f "$workload_repo_map_file" ]]; then
      repo_map_rows_local="$(
        awk -F'\t' '
          NR == FNR {
            if (NF >= 2) {
              key = $1 "\t" $2
              wanted[key] = 1
            }
            next
          }
          FNR == 1 { next }
          {
            key = $1 "\t" $2
            if (wanted[key]) {
              print $1 "\t" $2 "\t" $3 "\t" $5 "\t" $7 "\t" $8
            }
          }
        ' <(printf '%s\n' "$impacted_pod_keys_local") "$workload_repo_map_file" | sort -u
      )" || repo_map_rows_local=""
      if [[ -z "$repo_map_rows_local" ]]; then
        repo_map_note_local="no repo mapping matches for impacted pods"
      fi
    else
      repo_map_note_local="image repo map execution failed"
    fi
  else
    repo_map_note_local="repo mapping disabled (INCLUDE_REPO_MAP=${INCLUDE_REPO_MAP})"
  fi

  emit_step_var "impacted_pod_keys" "$impacted_pod_keys_local"
  emit_step_var "repo_map_rows" "$repo_map_rows_local"
  emit_step_var "repo_map_note" "$repo_map_note_local"
}

step_09_revisions() {
  local repo_map_rows_local
  repo_map_rows_local="${repo_map_rows:-}"
  local revision_rows_local="" revision_note_local="" suspect_pr_rows_local=""
  local suspect_pr_count_local=0 revision_resolved_count_local=0
  local revision_processed ns pod image repo local_repo_path _mapping_source
  local image_tag commit_hint commit_resolved commit_time commit_subject
  local pr_number pr_title pr_state pr_url commit_full commit_subject_raw
  local pr_row

  if [[ "$INCLUDE_IMAGE_REVISION" == "1" ]]; then
    if [[ -z "$repo_map_rows_local" ]]; then
      revision_note_local="no impacted repo mappings for revision lookup"
    else
      revision_processed=0
      while IFS=$'\t' read -r ns pod image repo local_repo_path _mapping_source; do
        [[ -z "$ns" || -z "$pod" || -z "$image" || -z "$repo" ]] && continue
        if [[ "$revision_processed" -ge "$RCA_ENRICH_LIMIT" ]]; then
          break
        fi

        image_tag="$(extract_image_tag "$image")"
        commit_hint="$(extract_commit_hint_from_tag "$image_tag")"
        commit_resolved="-"
        commit_time="-"
        commit_subject="-"
        pr_number="-"
        pr_title="-"
        pr_state="-"
        pr_url="-"

        if [[ -n "$commit_hint" && -n "$local_repo_path" && -d "$local_repo_path/.git" ]]; then
          commit_full="$(git -C "$local_repo_path" rev-parse --verify "${commit_hint}^{commit}" 2>/dev/null || true)"
          if [[ -n "$commit_full" ]]; then
            commit_resolved="$(git -C "$local_repo_path" rev-parse --short=12 "$commit_full" 2>/dev/null || printf '%s' "${commit_full:0:12}")"
            commit_time="$(git -C "$local_repo_path" show -s --format='%cI' "$commit_full" 2>/dev/null || echo '-')"
            commit_subject_raw="$(git -C "$local_repo_path" show -s --format='%s' "$commit_full" 2>/dev/null || true)"
            commit_subject="$(sanitize_signal_line "$commit_subject_raw")"
            if [[ -z "$commit_subject" ]]; then
              commit_subject="-"
            fi
            revision_resolved_count_local=$((revision_resolved_count_local + 1))

            if command -v gh >/dev/null 2>&1 && { [[ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]] || { [[ -n "${GITHUB_APP_ID:-}" ]] && [[ -n "${GITHUB_APP_PRIVATE_KEY:-}" ]]; }; }; then
              pr_row="$(
                gh api "repos/${repo}/commits/${commit_full}/pulls" \
                  -H "Accept: application/vnd.github+json" \
                  2>/dev/null \
                  | jq -r '
                      if type == "array" and length > 0 then
                        .[0]
                        | [
                            (.number | tostring),
                            ((.title // "-") | gsub("[\r\n\t]+"; " ")),
                            (.state // "-"),
                            (.html_url // "-")
                          ]
                        | @tsv
                      else
                        empty
                      end
                    ' 2>/dev/null || true
              )"
              if [[ -n "$pr_row" ]]; then
                IFS=$'\t' read -r pr_number pr_title pr_state pr_url <<<"$pr_row"
                pr_title="$(sanitize_signal_line "$pr_title")"
                if [[ -z "$pr_title" ]]; then
                  pr_title="-"
                fi
                suspect_pr_rows_local="${suspect_pr_rows_local}${repo}"$'\t'"${pr_number}"$'\t'"${pr_title}"$'\t'"${pr_state}"$'\t'"${pr_url}"$'\t'"${ns}"$'\t'"${pod}"$'\n'
              fi
            fi
          fi
        fi

        revision_rows_local="${revision_rows_local}${ns}"$'\t'"${pod}"$'\t'"${image}"$'\t'"${repo}"$'\t'"${image_tag:--}"$'\t'"${commit_hint:--}"$'\t'"${commit_resolved}"$'\t'"${commit_time}"$'\t'"${commit_subject}"$'\t'"${pr_number}"$'\t'"${pr_title}"$'\t'"${pr_state}"$'\t'"${pr_url}"$'\n'
        revision_processed=$((revision_processed + 1))
      done < <(printf '%s\n' "$repo_map_rows_local")

      revision_rows_local="$(printf '%s' "$revision_rows_local" | awk 'NF > 0 { print }')" || revision_rows_local=""
      suspect_pr_rows_local="$(printf '%s' "$suspect_pr_rows_local" | awk 'NF > 0 { print }' | sort -u)" || suspect_pr_rows_local=""
      suspect_pr_count_local="$(count_lines "$suspect_pr_rows_local")"

      if [[ -z "$revision_rows_local" ]]; then
        revision_note_local="unable to resolve image revision signals"
      elif [[ "$suspect_pr_count_local" -eq 0 ]]; then
        revision_note_local="no PR association found for resolved image revisions"
      fi
    fi
  else
    revision_note_local="image revision enrichment disabled (INCLUDE_IMAGE_REVISION=${INCLUDE_IMAGE_REVISION})"
  fi

  emit_step_var "revision_rows" "$revision_rows_local"
  emit_step_var "revision_note" "$revision_note_local"
  emit_step_var "suspect_pr_rows" "$suspect_pr_rows_local"
  emit_step_var "suspect_pr_count" "$suspect_pr_count_local"
  emit_step_var "revision_resolved_count" "$revision_resolved_count_local"
}

step_10_ci_signals() {
  local repo_map_rows_local
  repo_map_rows_local="${repo_map_rows:-}"
  local ci_rows_local="" ci_note_local="" repos_for_ci repo ci_output ci_row
  local ci_status_script

  if [[ "$INCLUDE_CI_SIGNAL" == "1" ]]; then
    ci_status_script="${RCA_SCRIPT_DIR%/}/github-ci-status.sh"
    if [[ ! -f "$ci_status_script" ]]; then
      ci_note_local="github ci status script missing: ${ci_status_script}"
    else
      repos_for_ci="$(
        printf '%s\n' "$repo_map_rows_local" \
          | awk -F'\t' 'NF >= 4 && $4 != "" { print $4 }' \
          | sort -u \
          | sed -n "1,${CI_REPO_LIMIT}p"
      )" || repos_for_ci=""
      if [[ -z "$repos_for_ci" ]]; then
        ci_note_local="no mapped repos to query"
      else
        while IFS= read -r repo; do
          [[ -z "$repo" ]] && continue
          ci_output="$(GITHUB_CI_STRICT=0 bash "$ci_status_script" --repo "$repo" --limit "$CI_RUN_LIMIT" 2>/dev/null || true)"
          ci_row="$(printf '%s\n' "$ci_output" | awk -F'\t' 'NR == 1 { next } NF >= 9 { print; exit }')"
          if [[ -n "$ci_row" ]]; then
            ci_rows_local="${ci_rows_local}${ci_row}"$'\n'
          fi
        done < <(printf '%s\n' "$repos_for_ci")
        ci_rows_local="$(printf '%s' "$ci_rows_local" | awk 'NF > 0 { print }')" || ci_rows_local=""
        if [[ -z "$ci_rows_local" ]]; then
          ci_note_local="github ci queries returned no rows"
        fi
      fi
    fi
  else
    ci_note_local="github ci enrichment disabled (INCLUDE_CI_SIGNAL=${INCLUDE_CI_SIGNAL})"
  fi

  emit_step_var "ci_rows" "$ci_rows_local"
  emit_step_var "ci_note" "$ci_note_local"
}

NS_FILTER_JSON="$(to_json_array "$SCOPE_NAMESPACES")"
IGNORE_ALERTS_JSON="$(to_json_array "$IGNORE_ALERTNAMES")"
ensure_positive_int POD_LIMIT 20
ensure_positive_int DEPLOY_LIMIT 20
ensure_positive_int EVENT_LIMIT 30
ensure_positive_int ALERT_LIMIT 25
ensure_positive_int CONTAINER_LIMIT 30
ensure_positive_int LOG_SNIPPET_PODS_LIMIT 5
ensure_positive_int LOG_SNIPPET_LINES 120
ensure_positive_int LOG_SNIPPET_ERRORS_PER_CONTAINER 3
ensure_positive_int RESTART_THRESHOLD 3
ensure_positive_int RCA_ENRICH_LIMIT 8
ensure_positive_int CI_REPO_LIMIT 3
ensure_positive_int CI_RUN_LIMIT 3
ensure_positive_int LINEAR_MEMORY_LIMIT 5
ensure_positive_int PROMETHEUS_TIMEOUT_SECONDS 120
ensure_positive_int ARGOCD_TIMEOUT_SECONDS 120
ensure_positive_int STEP_TIMEOUT_POD_DEPLOY_SECONDS 180
ensure_positive_int STEP_TIMEOUT_EVENTS_ALERTS_SECONDS 180
ensure_positive_int STEP_TIMEOUT_LINEAR_MEMORY_SECONDS 180
ensure_positive_int STEP_TIMEOUT_PROMETHEUS_TRENDS_SECONDS 300
ensure_positive_int STEP_TIMEOUT_ARGOCD_SYNC_SECONDS 300
ensure_positive_int STEP_TIMEOUT_LOG_SIGNALS_SECONDS 300
ensure_positive_int STEP_TIMEOUT_CERT_SECRET_HEALTH_SECONDS 180
ensure_positive_int STEP_TIMEOUT_AWS_RESOURCE_SIGNALS_SECONDS 180
ensure_positive_int STEP_TIMEOUT_DB_EVIDENCE_SECONDS 240
ensure_positive_int STEP_TIMEOUT_IMAGE_REPO_SECONDS 300
ensure_positive_int STEP_TIMEOUT_REVISIONS_SECONDS 300
ensure_positive_int STEP_TIMEOUT_CI_SIGNALS_SECONDS 300
ensure_non_negative_int ALERT_COOLDOWN_SECONDS 1800
ensure_non_negative_int ALERT_MIN_INTERVAL_SECONDS 3600
ensure_non_negative_int RCA_MIN_RERUN_INTERVAL_S 3600
ensure_non_negative_int RCA_EVIDENCE_TOTAL_TIMEOUT_MS 80000
ensure_non_negative_int SEVERITY_CRITICAL_SCORE 85
ensure_non_negative_int SEVERITY_HIGH_SCORE 60
ensure_non_negative_int SEVERITY_MEDIUM_SCORE 30

mkdir -p "$SPOOL_DIR" 2>/dev/null || true
cleanup_spool

HAS_LIB_STATE_FILE=0
HAS_LIB_INCIDENT_ID=0
HAS_LIB_CONTINUITY_MATCHER=0
HAS_LIB_LINEAR_PREFLIGHT=0
HAS_LIB_LINEAR_TICKET=0
HAS_LIB_OUTBOX=0
HAS_LIB_RCA_PROMPT=0
HAS_LIB_RCA_LLM=0
HAS_LIB_RCA_CROSSREVIEW=0
HAS_LIB_RCA_SAFETY=0
HAS_LIB_RCA_CHAIN=0
HAS_LIB_RCA_SINK=0
HAS_LIB_THREAD_ARCHIVAL=0
HAS_LIB_META_ALERTS=0
HAS_LIB_SERVICE_GRAPH=0
HAS_LIB_SERVICE_OVERLAY=0
HAS_LIB_INCIDENT_MEMORY=0
HAS_LIB_INCIDENT_DOSSIER=0
HAS_LIB_EVIDENCE_ROW=0
HAS_LIB_REWARDS_PROVIDER_EVIDENCE=0
HAS_LIB_TIMELINE=0
HAS_LIB_SERVICE_CONTEXT=0
HAS_LIB_OVERLAY_SUGGESTIONS=0

source_optional_lib "lib-state-file" HAS_LIB_STATE_FILE
source_optional_lib "lib-incident-id" HAS_LIB_INCIDENT_ID
source_optional_lib "lib-continuity-matcher" HAS_LIB_CONTINUITY_MATCHER
source_optional_lib "lib-linear-preflight" HAS_LIB_LINEAR_PREFLIGHT
source_optional_lib "lib-linear-ticket" HAS_LIB_LINEAR_TICKET
source_optional_lib "lib-outbox" HAS_LIB_OUTBOX
source_optional_lib "lib-rca-prompt" HAS_LIB_RCA_PROMPT
source_optional_lib "lib-rca-llm" HAS_LIB_RCA_LLM
source_optional_lib "lib-rca-crossreview" HAS_LIB_RCA_CROSSREVIEW
source_optional_lib "lib-rca-safety" HAS_LIB_RCA_SAFETY
source_optional_lib "lib-rca-chain" HAS_LIB_RCA_CHAIN
source_optional_lib "lib-rca-sink" HAS_LIB_RCA_SINK
source_optional_lib "lib-thread-archival" HAS_LIB_THREAD_ARCHIVAL
source_optional_lib "lib-meta-alerts" HAS_LIB_META_ALERTS
source_optional_lib "lib-service-graph" HAS_LIB_SERVICE_GRAPH
source_optional_lib "lib-service-overlay" HAS_LIB_SERVICE_OVERLAY
source_optional_lib "lib-incident-memory" HAS_LIB_INCIDENT_MEMORY
source_optional_lib "lib-incident-dossier" HAS_LIB_INCIDENT_DOSSIER
source_optional_lib "lib-evidence-row" HAS_LIB_EVIDENCE_ROW
source_optional_lib "lib-rewards-provider-evidence" HAS_LIB_REWARDS_PROVIDER_EVIDENCE
source_optional_lib "lib-evidence-gaps" HAS_LIB_EVIDENCE_GAPS
source_optional_lib "lib-hypothesis-recollect" HAS_LIB_HYPOTHESIS_RECOLLECT
source_optional_lib "lib-timeline" HAS_LIB_TIMELINE
source_optional_lib "lib-service-context" HAS_LIB_SERVICE_CONTEXT
source_optional_lib "lib-overlay-suggestions" HAS_LIB_OVERLAY_SUGGESTIONS

export KUBECTL_TIMEOUT K8S_CONTEXT PROMETHEUS_TIMEOUT_SECONDS PROMETHEUS_URL
export ARGOCD_BASE_URL ARGOCD_TIMEOUT_SECONDS
export NS_FILTER_JSON IGNORE_ALERTS_JSON RESTART_THRESHOLD
export INCLUDE_LOG_SNIPPETS LOG_SNIPPET_PODS_LIMIT LOG_SNIPPET_LINES LOG_SNIPPET_ERRORS_PER_CONTAINER
export INCLUDE_REPO_MAP INCLUDE_CI_SIGNAL INCLUDE_IMAGE_REVISION RCA_SCRIPT_DIR RCA_ENRICH_LIMIT CI_REPO_LIMIT CI_RUN_LIMIT
export SCOPE_NAMESPACES SCRIPT_DIR RCA_MODE LINEAR_MEMORY_LIMIT ACTIVE_INCIDENTS_FILE RESOLVED_INCIDENTS_FILE INCIDENT_LAST_ACTIVE_FILE
export SERVICE_CONTEXT_ENABLED RCA_CHAIN_ENABLED INCIDENT_LEARNING_ENABLED RCA_EVIDENCE_TOTAL_TIMEOUT_MS RCA_MIN_RERUN_INTERVAL_S
export CHANGE_WINDOW_MINUTES DB_EVIDENCE_ENABLED DB_EVIDENCE_NAMESPACE STEP_TIMEOUT_DB_EVIDENCE_SECONDS

write_phase1_shadow_artifacts() {
  [[ "$incident" -eq 1 ]] || return 0
  local structured_evidence_enabled="${OPENCLAW_SRE_STRUCTURED_EVIDENCE_ENABLED:-0}"
  local incident_dossier_enabled="${OPENCLAW_SRE_INCIDENT_DOSSIER_ENABLED:-0}"
  [[ "$structured_evidence_enabled" == "1" || "$incident_dossier_enabled" == "1" ]] || return 0
  [[ "$HAS_LIB_EVIDENCE_ROW" -eq 1 && "$HAS_LIB_INCIDENT_DOSSIER" -eq 1 ]] || return 0
  declare -F evidence_row_build >/dev/null 2>&1 || return 0
  declare -F evidence_rows_write_ndjson >/dev/null 2>&1 || return 0
  declare -F incident_dossier_write_bundle >/dev/null 2>&1 || return 0
  command -v jq >/dev/null 2>&1 || return 0

  local observed_at incident_scope timeline_detected timeline_state timeline_rca
  observed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  incident_scope="${step11_dedup_namespace:-unknown}/${step11_dedup_category:-unknown}"

  local summary_payload rca_payload summary_row rca_row evidence_file timeline_ndjson merged_timeline_ndjson
  summary_payload="$(
    jq -nc \
      --arg incident_id "${incident_id:-unknown}" \
      --arg namespace "${step11_dedup_namespace:-unknown}" \
      --arg category "${step11_dedup_category:-unknown}" \
      --arg severity "${severity_level:-unknown}" \
      --arg fingerprint "${incident_fingerprint:-unknown}" \
      --arg gate_reason "${gate_reason:-}" \
      --argjson primary_impact_signals "$(normalize_json_number_or "${primary_impact_signals:-0}" 0)" \
      '{
        incident_id: $incident_id,
        namespace: $namespace,
        category: $category,
        severity: $severity,
        incident_fingerprint: $fingerprint,
        gate_reason: $gate_reason,
        primary_impact_signals: $primary_impact_signals
      }'
  )"
  summary_row="$(evidence_row_build "sentinel-triage" "incident_summary" "$incident_scope" "$observed_at" "$summary_payload" "" "${rca_confidence:-0}" 900)"
  summary_row="$(printf '%s\n' "$summary_row" | jq -c --arg incident_ref "incident:${incident_id:-unknown}" '.entity_ids = [$incident_ref]')"

  rca_payload="$(
    jq -nc \
      --argjson rca "$(normalize_json_compact_or "${rca_result_json:-}" '{}')" \
      --arg mode "${rca_mode_effective:-unknown}" \
      --arg source "${rca_result_source:-unknown}" \
      --arg status "${rca_result_status:-unknown}" \
      --arg summary "${rca_summary:-}" \
      '{
        mode: $mode,
        source: $source,
        status: $status,
        summary: $summary,
        rca: $rca
      }'
  )"
  rca_row="$(evidence_row_build "sentinel-triage" "rca_result" "$incident_scope" "$observed_at" "$rca_payload" "" "${rca_confidence:-0}" 1800)"
  rca_row="$(printf '%s\n' "$rca_row" | jq -c --arg incident_ref "incident:${incident_id:-unknown}" '.entity_ids = [$incident_ref]')"

  evidence_file="$(mktemp "${TMPDIR:-/tmp}/openclaw-sre-evidence.XXXXXX")"
  evidence_rows_write_ndjson "$evidence_file" "$summary_row" "$rca_row"
  if [[ -n "${changes_in_window_evidence_ndjson:-}" ]]; then
    printf '%s\n' "${changes_in_window_evidence_ndjson}" >>"$evidence_file"
  fi
  if [[ "$structured_evidence_enabled" == "1" ]]; then
    local evidence_dir evidence_target
    evidence_dir="${OPENCLAW_SRE_INDEX_DIR:-/home/node/.openclaw/state/sre-index}/shadow-evidence"
    mkdir -p "$evidence_dir" 2>/dev/null || true
    evidence_target="${evidence_dir}/$(printf '%s' "${incident_id:-unknown}" | sed -E 's/[^A-Za-z0-9._:-]+/_/g').ndjson"
    cp "$evidence_file" "$evidence_target" 2>/dev/null || true
  fi

  timeline_detected="$(
    jq -nc \
      --arg ts "$observed_at" \
      --arg incident_id "${incident_id:-unknown}" \
      --arg namespace "${step11_dedup_namespace:-unknown}" \
      '{version:"sre.timeline-event.v1", event:"detected", observed_at:$ts, incident_id:$incident_id, namespace:$namespace}'
  )"
  timeline_state="$(
    jq -nc \
      --arg ts "$observed_at" \
      --arg incident_state_status "${incident_state_status:-disabled}" \
      '{version:"sre.timeline-event.v1", event:"state_update", observed_at:$ts, incident_state_status:$incident_state_status}'
  )"
  timeline_rca="$(
    jq -nc \
      --arg ts "$observed_at" \
      --arg rca_status "${rca_result_status:-fallback}" \
      --arg summary "${rca_summary:-}" \
      '{version:"sre.timeline-event.v1", event:"rca_ready", observed_at:$ts, rca_status:$rca_status, summary:$summary}'
  )"
  timeline_ndjson="$(printf '%s\n%s\n%s\n' "$timeline_detected" "$timeline_state" "$timeline_rca")"
  merged_timeline_ndjson="$timeline_ndjson"
  if [[ -n "${changes_in_window_timeline_ndjson:-}" ]]; then
    if [[ "$HAS_LIB_TIMELINE" -eq 1 ]] && declare -F timeline_merge_sort_ndjson >/dev/null 2>&1; then
      merged_timeline_ndjson="$(
        printf '%s\n%s\n' "$timeline_ndjson" "${changes_in_window_timeline_ndjson}" | timeline_merge_sort_ndjson 2>/dev/null || printf '%s\n%s\n' "$timeline_ndjson" "${changes_in_window_timeline_ndjson}"
      )"
    else
      merged_timeline_ndjson="$(printf '%s\n%s\n' "$timeline_ndjson" "${changes_in_window_timeline_ndjson}")"
    fi
  fi

  local incident_json hypotheses_json actions_json entities_json links_json evidence_ndjson
  incident_json="$(
    jq -nc \
      --arg version "sre.incident.shadow.v1" \
      --arg incident_id "${incident_id:-unknown}" \
      --arg namespace "${step11_dedup_namespace:-unknown}" \
      --arg category "${step11_dedup_category:-unknown}" \
      --arg severity "${severity_level:-unknown}" \
      --arg fingerprint "${incident_fingerprint:-unknown}" \
      --arg status "${rca_result_status:-fallback}" \
      --arg observed_at "$observed_at" \
      --argjson confidence "$(normalize_json_number_or "${rca_confidence:-0}" 0)" \
      '{
        version: $version,
        incident_id: $incident_id,
        namespace: $namespace,
        category: $category,
        severity: $severity,
        incident_fingerprint: $fingerprint,
        status: $status,
        observed_at: $observed_at,
        confidence: $confidence,
        shadow_mode: true
      }'
  )"
  hypotheses_json="$(printf '%s\n' "${rca_result_json:-{}}" | jq -c '.hypotheses // []' 2>/dev/null || printf '[]')"
  actions_json="$(
    jq -nc \
      --arg observed_at "$observed_at" \
      '[
        {
          kind: "shadow_mode",
          observed_at: $observed_at,
          note: "Primary RCA thread output unchanged; structured action bundle written in shadow mode."
        }
      ]'
  )"
  entities_json="$(
    jq -nc \
      --arg incident_ref "incident:${incident_id:-unknown}" \
      --arg namespace "${step11_dedup_namespace:-unknown}" \
      --arg category "${step11_dedup_category:-unknown}" \
      --arg slack_thread_ts "${existing_slack_thread_ts:-}" \
      --arg linear_ticket_id "${existing_linear_ticket_id:-}" \
      '[
        {
          entity_id: $incident_ref,
          entity_type: "incident",
          namespace: $namespace,
          category: $category
        }
      ]
      + (if $slack_thread_ts != "" then [{entity_id: ("thread:" + $slack_thread_ts), entity_type: "thread"}] else [] end)
      + (if $linear_ticket_id != "" then [{entity_id: ("linear:" + $linear_ticket_id), entity_type: "ticket"}] else [] end)'
  )"
  links_json="$(
    jq -nc \
      --arg slack_thread_ts "${existing_slack_thread_ts:-}" \
      --arg linear_ticket_id "${existing_linear_ticket_id:-}" \
      --arg betterstack_alias "${betterstack_alias:-}" \
      '[
        (if $slack_thread_ts != "" then {kind:"slack_thread", value:$slack_thread_ts} else empty end),
        (if $linear_ticket_id != "" then {kind:"linear_ticket", value:$linear_ticket_id} else empty end),
        (if $betterstack_alias != "" then {kind:"betterstack_alias", value:$betterstack_alias} else empty end)
      ]'
  )"
  evidence_ndjson="$(cat "$evidence_file")"

  if [[ "$incident_dossier_enabled" == "1" ]]; then
    incident_dossier_write_bundle \
      "${incident_id:-unknown}" \
      "${step11_dedup_namespace:-unknown}" \
      "${step11_dedup_category:-unknown}" \
      "${severity_level:-unknown}" \
      "$incident_json" \
      "$merged_timeline_ndjson" \
      "$evidence_ndjson" \
      "$hypotheses_json" \
      "$actions_json" \
      "$entities_json" \
      "$links_json" \
      >/dev/null 2>&1 || true
  fi

  rm -f "$evidence_file" >/dev/null 2>&1 || true
}

collect_change_window_context() {
  changes_in_window_status="skipped"
  changes_in_window_note="disabled"
  changes_in_window_summary=""
  changes_in_window_timeline_ndjson=""
  changes_in_window_evidence_ndjson=""

  [[ "${OPENCLAW_SRE_CHANGE_INTEL_ENABLED:-0}" == "1" ]] || return 0
  command -v jq >/dev/null 2>&1 || {
    changes_in_window_note="missing_jq"
    return 0
  }

  local helper_script output_local
  helper_script="$(resolve_helper_script "changes-in-window.sh")"
  [[ -n "$helper_script" ]] || {
    changes_in_window_note="script_missing"
    return 0
  }

  output_local="$(bash "$helper_script" 2>/dev/null || true)"
  [[ -n "$output_local" ]] || {
    changes_in_window_note="empty_output"
    return 0
  }

  changes_in_window_status="ready"
  changes_in_window_note="none"
  changes_in_window_summary="$(printf '%s\n' "$output_local" | jq -r '.summary_block // ""' 2>/dev/null || true)"
  changes_in_window_timeline_ndjson="$(printf '%s\n' "$output_local" | jq -r '.timeline_ndjson // ""' 2>/dev/null || true)"
  changes_in_window_evidence_ndjson="$(printf '%s\n' "$output_local" | jq -r '.evidence_ndjson // ""' 2>/dev/null || true)"
}

collect_phase2_drift_and_lineage() {
  config_drift_output=""
  config_lineage_output=""
  config_drift_count=0

  [[ "${OPENCLAW_SRE_CHANGE_INTEL_ENABLED:-0}" == "1" ]] || return 0

  local drift_script lineage_script scope
  drift_script="$(resolve_helper_script "config-drift-detector.sh")"
  lineage_script="$(resolve_helper_script "helm-lineage-tracker.sh")"
  scope="${step11_dedup_namespace:-unknown}/${step11_primary_service:-unknown}"

  if [[ -n "$drift_script" ]]; then
    config_drift_output="$(CONFIG_DRIFT_SCOPE="$scope" bash "$drift_script" 2>/dev/null || true)"
    config_drift_count="$(printf '%s\n' "$config_drift_output" | awk 'NF > 0 { c++ } END { print c + 0 }')"
  fi

  if [[ -n "$lineage_script" ]]; then
    config_lineage_output="$(HELM_LINEAGE_SCOPE="$scope" bash "$lineage_script" 2>/dev/null || true)"
  fi
}

db_evidence_should_collect() {
  [[ "${DB_EVIDENCE_ENABLED:-1}" == "1" ]] || return 1
  local combined
  combined="$(
    {
      printf '%s\n' "${BETTERSTACK_CONTEXT:-}"
      printf '%s\n' "${alert_rows:-}"
      printf '%s\n' "${event_rows:-}"
      printf '%s\n' "${log_signal_rows:-}"
      printf '%s\n' "${pod_rows:-}"
      printf '%s\n' "${container_state_rows:-}"
    } | tr '[:upper:]' '[:lower:]'
  )"
  [[ -n "$combined" ]] || return 1
  if rewards_provider_should_collect_if_available "$combined"; then
    return 0
  fi
  case "$combined" in
    *postgres*|*replica*|*replication*|*replay\ lag*|*database*|*db-*|*indexer*|*graphql*|*stale*|*wrong\ value*|*apy*|*vault*|*query*|*table*)
      return 0
      ;;
  esac
  return 1
}

db_evidence_target_guess() {
  local combined="${1:-}"
  if rewards_provider_should_collect_if_available "$combined"; then
    printf 'blue_api\n'
    return 0
  fi
  case "$combined" in
    *indexer*|*replica*|*replication*|*replay\ lag*|*apy*|*graphql*|*vault*)
      printf 'indexer\n'
      ;;
    *realtime*)
      printf 'realtime\n'
      ;;
    *historical*)
      printf 'historical\n'
      ;;
    *processor*)
      printf 'processor\n'
      ;;
    *)
      printf 'blue_api\n'
      ;;
  esac
}

collect_phase2_db_evidence() {
  db_evidence_status="skipped"
  db_evidence_note="disabled"
  db_evidence_target=""
  db_evidence_rows=""
  db_schema_check=0
  db_data_check=0
  pg_internal_check=0
  replica_lag=0
  pg_activity=0
  pg_statements=0
  pg_conflicts=0
  db_topology=0

  db_evidence_should_collect || return 0

  local db_script namespace combined target output note schema_state query_state evidence_line rows
  db_script="$(resolve_helper_script "db-evidence.sh")"
  [[ -n "$db_script" ]] || {
    db_evidence_note="script_missing"
    return 0
  }

  combined="$(
    {
      printf '%s\n' "${BETTERSTACK_CONTEXT:-}"
      printf '%s\n' "${alert_rows:-}"
      printf '%s\n' "${event_rows:-}"
      printf '%s\n' "${log_signal_rows:-}"
      printf '%s\n' "${pod_rows:-}"
      printf '%s\n' "${container_state_rows:-}"
    } | tr '[:upper:]' '[:lower:]'
  )"
  target="$(db_evidence_target_guess "$combined")"
  namespace="$(
    printf '%s' "${DB_EVIDENCE_NAMESPACE:-${step11_dedup_namespace:-$(printf '%s' "$SCOPE_NAMESPACES" | awk -F',' '{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $1); print $1}')}}" \
      | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
  )"
  [[ -n "$namespace" ]] || namespace="morpho-prd"

  output="$(
    run_with_timeout "${STEP_TIMEOUT_DB_EVIDENCE_SECONDS}s" \
      bash "$db_script" --namespace "$namespace" --target "$target" --mode summary 2>/dev/null || true
  )"
  [[ -n "$output" ]] || {
    db_evidence_status="empty"
    db_evidence_note="empty_output"
    db_evidence_target="$target"
    return 0
  }

  note="$(printf '%s\n' "$output" | jq -r '.note // .error // "none"' 2>/dev/null || printf 'parse_failed')"
  schema_state="$(printf '%s\n' "$output" | jq -r '.schema_check // "failed"' 2>/dev/null || printf 'failed')"
  query_state="$(printf '%s\n' "$output" | jq -r '.query_check // "failed"' 2>/dev/null || printf 'failed')"
  evidence_line="$(printf '%s\n' "$output" | jq -r '.evidence_line // empty' 2>/dev/null || true)"
  rows="$(printf '%s\n' "$output" | jq -r '.rows // 0' 2>/dev/null || printf '0')"
  db_evidence_rows="${db_evidence_rows}summary"$'\t'"${schema_state}"$'\t'"${query_state}"$'\t'"${rows}"$'\t'"${note}"$'\t'"${evidence_line}"$'\n'
  if [[ "$schema_state" == "ok" ]]; then
    db_schema_check=1
    db_topology=1
  fi
  if [[ "$query_state" == "ok" ]]; then
    db_data_check=1
  fi
  if [[ "$(printf '%s\n' "$output" | jq -r '.pg_internal_check // "failed"' 2>/dev/null || printf 'failed')" == "ok" ]]; then
    pg_internal_check=1
  fi
  if [[ "$(printf '%s\n' "$output" | jq -r '.replica // "unknown"' 2>/dev/null || printf 'unknown')" != "unknown" ]]; then
    replica_lag=1
    db_topology=1
  fi
  if [[ "$(printf '%s\n' "$output" | jq -r '.active_queries // "0"' 2>/dev/null || printf '0')" != "0" ]]; then
    pg_activity=1
  fi
  if [[ "$(printf '%s\n' "$output" | jq -r '.statement_count // "0"' 2>/dev/null || printf '0')" != "0" ]]; then
    pg_statements=1
  fi
  if [[ "$(printf '%s\n' "$output" | jq -r '.conflict_snapshot // "0"' 2>/dev/null || printf '0')" != "0" ]]; then
    pg_conflicts=1
  fi

  db_evidence_rows="$(printf '%s' "$db_evidence_rows" | awk 'NF > 0 { print }')" || db_evidence_rows=""
  db_evidence_target="$target"
  if [[ -n "$db_evidence_rows" ]]; then
    db_evidence_status="ready"
    db_evidence_note="none"
  else
    db_evidence_status="empty"
    db_evidence_note="empty_output"
  fi
}

if ! declare -F collect_phase2_rewards_provider_context >/dev/null 2>&1; then
collect_phase2_rewards_provider_context() {
  rewards_provider_mode=0
  provider_api_check=0
  artifact_check=0
  code_path_check=0
  disproved_theory_recorded=0
  rewards_provider_context_note=""
  provider_api_evidence_output=""
  artifact_evidence_output=""
  code_path_evidence_output=""
  disproved_theory_evidence_output=""

  local raw_combined combined
  local provider_api_evidence_output_local artifact_evidence_output_local
  local code_path_evidence_output_local disproved_theory_evidence_output_local
  raw_combined="$(
    {
      printf '%s\n' "${BETTERSTACK_CONTEXT:-}"
      printf '%s\n' "${alert_rows:-}"
      printf '%s\n' "${event_rows:-}"
      printf '%s\n' "${log_signal_rows:-}"
      printf '%s\n' "${repo_map_rows:-}"
      printf '%s\n' "${revision_rows:-}"
      printf '%s\n' "${ci_rows:-}"
      printf '%s\n' "${changes_in_window_summary:-}"
    }
  )"
  combined="$(printf '%s' "$raw_combined" | tr '[:upper:]' '[:lower:]')"

  rewards_provider_should_collect "$combined" || return 0
  rewards_provider_mode=1

  provider_api_evidence_output_local="$(printf '%s' "${provider_api_evidence_input:-}" | awk 'NF > 0 { print }')"
  artifact_evidence_output_local="$(printf '%s' "${artifact_evidence_input:-}" | awk 'NF > 0 { print }')"
  code_path_evidence_output_local="$(printf '%s' "${code_path_evidence_input:-}" | awk 'NF > 0 { print }')"
  disproved_theory_evidence_output_local="$(printf '%s' "${disproved_theory_evidence_input:-}" | awk 'NF > 0 { print }')"

  if [[ -z "$provider_api_evidence_output_local" ]]; then
    provider_api_evidence_output_local="$(
      printf '%s\n' "$raw_combined" \
        | grep -Eom1 '(GET /v4/opportunities/campaigns[^[:space:]]*|https?://[^[:space:]]*api\.merkl[^[:space:]]*|campaigns\.morpho\.org[^[:space:]]*)' \
        || true
    )"
  fi

  if [[ -z "$artifact_evidence_output_local" ]]; then
    if [[ -n "${changes_in_window_summary:-}" ]] && printf '%s\n' "${changes_in_window_summary:-}" | grep -Eiq '(artifact|snapshot|dump|cache|workflow)'; then
      artifact_evidence_output_local="$(sanitize_signal_line "$changes_in_window_summary")"
    elif [[ -n "${ci_rows:-}" ]]; then
      artifact_evidence_output_local="$(sanitize_signal_line "$(printf '%s\n' "$ci_rows" | awk 'NF > 0 { print; exit }')")"
    fi
  fi

  if [[ -z "$code_path_evidence_output_local" ]]; then
    code_path_evidence_output_local="$(
      printf '%s\n' "$raw_combined" \
        | grep -Eom1 '([A-Za-z0-9._-]+/)+[A-Za-z0-9._-]+\.(ts|tsx|js|jsx|sql|ya?ml|json|sh)(:[0-9]+)?' \
        || true
    )"
  fi

  if [[ -n "$provider_api_evidence_output_local" ]]; then
    provider_api_check=1
  fi

  if [[ -n "$artifact_evidence_output_local" ]]; then
    artifact_check=1
  fi

  if [[ -n "$code_path_evidence_output_local" ]]; then
    code_path_check=1
  fi

  if [[ -n "$disproved_theory_evidence_output_local" ]]; then
    disproved_theory_recorded=1
  fi

  provider_api_evidence_output="$provider_api_evidence_output_local"
  artifact_evidence_output="$artifact_evidence_output_local"
  code_path_evidence_output="$code_path_evidence_output_local"
  disproved_theory_evidence_output="$disproved_theory_evidence_output_local"

  if [[ "$provider_api_check" -eq 0 || "$artifact_check" -eq 0 || "$code_path_check" -eq 0 ]]; then
    rewards_provider_context_note="explicit or raw provider/artifact/code-path evidence outputs are still incomplete; rewards/provider gate remains closed until those live facts are recorded"
  fi
}
fi

indexer_freshness_should_collect() {
  local combined="${1:-}"
  [[ -n "$combined" ]] || return 1
  combined="$(printf '%s' "$combined" | tr '[:upper:]' '[:lower:]')"
  case "$combined" in
    *indexer\ delay*|*indexing\ latency*|*check-indexing-latency*|*sqd_processor_chain_height*|*sqd_processor_last_block*|*headblock*|*eth_getlogs*|*indexer-*morpho*|*create-historical-rewards-state*)
      return 0
      ;;
  esac
  return 1
}

count_recent_matching_incidents() {
  local workload_key="${1:-}"
  local cutoff_ts="${2:-0}"
  local rows=""
  local normalized_workload_key row affected last_seen
  local count=0

  if [[ -z "$workload_key" ]] || ! [[ "$cutoff_ts" =~ ^[0-9]+$ ]]; then
    printf '0\n'
    return 0
  fi

  normalized_workload_key="$(normalize_pipe_atoms "$workload_key")"
  if [[ -z "$normalized_workload_key" ]]; then
    printf '0\n'
    return 0
  fi

  if [[ "$HAS_LIB_STATE_FILE" -eq 1 ]] && declare -F state_read_all >/dev/null 2>&1; then
    rows="$(
      {
        state_read_all "$ACTIVE_INCIDENTS_FILE" 2>/dev/null || true
        state_read_all "$RESOLVED_INCIDENTS_FILE" 2>/dev/null || true
      } | awk -F'\t' 'NF >= 12 { print }'
    )"
  else
    rows="$(
      {
        cat "$ACTIVE_INCIDENTS_FILE" 2>/dev/null || true
        cat "$RESOLVED_INCIDENTS_FILE" 2>/dev/null || true
      } | awk -F'\t' 'NF >= 12 { print }'
    )"
  fi

  if [[ -z "$rows" ]]; then
    printf '0\n'
    return 0
  fi

  while IFS= read -r row; do
    [[ -n "$row" ]] || continue
    affected="$(tsv_field "$row" 12)"
    last_seen="$(tsv_field "$row" 5)"
    [[ "$last_seen" =~ ^[0-9]+$ ]] || continue
    (( last_seen >= cutoff_ts )) || continue
    if pipe_atom_sets_intersect "$affected" "$normalized_workload_key"; then
      count=$((count + 1))
    fi
  done <<<"$rows"

  printf '%s\n' "$count"
}

collect_phase2_indexer_freshness_context() {
  indexer_freshness_mode=0
  indexer_db_vs_live_head_gap=0
  indexer_processed_vs_head_rate_gap=0
  indexer_metric_blind_spot=0
  indexer_resources_missing=0
  indexer_queue_backlog=0
  indexer_rpc_mismatch=0
  indexer_recurring_incident=0
  indexer_recent_match_count=0
  indexer_workloads=""
  indexer_canonical_category_hint="unknown"
  indexer_freshness_note="disabled"

  local raw_combined combined current_ts cutoff_ts
  raw_combined="$(
    {
      printf '%s\n' "${BETTERSTACK_CONTEXT:-}"
      printf '%s\n' "${alert_rows:-}"
      printf '%s\n' "${event_rows:-}"
      printf '%s\n' "${log_signal_rows:-}"
      printf '%s\n' "${pod_rows:-}"
      printf '%s\n' "${container_state_rows:-}"
      printf '%s\n' "${db_evidence_rows:-}"
      printf '%s\n' "${changes_in_window_summary:-}"
      printf '%s\n' "${revision_rows:-}"
      printf '%s\n' "${ci_rows:-}"
    } | awk 'NF > 0 { print }'
  )"
  combined="$(printf '%s' "$raw_combined" | tr '[:upper:]' '[:lower:]')"

  indexer_freshness_should_collect "$combined" || {
    indexer_freshness_note="not_indexer_freshness"
    return 0
  }

  indexer_freshness_mode=1
  indexer_freshness_note="trigger_only"
  indexer_workloads="$(derive_step11_workloads "${deploy_rows:-}" "${pod_rows:-}" 2>/dev/null || true)"

  if printf '%s\n' "$combined" | grep -Eiq 'db latest .* behind|headblock.*behind|live rpc.*ahead|stale by .*minutes|[0-9]+ blocks / [0-9]+s behind|timestamp gap'; then
    indexer_db_vs_live_head_gap=1
  fi
  if printf '%s\n' "$combined" | grep -Eiq 'chain head advanced .* while the indexer processed|not keeping up|throughput degradation|outpacing this single indexer replica|treading water|blocks/sec'; then
    indexer_processed_vs_head_rate_gap=1
  fi
  if printf '%s\n' "$combined" | grep -Eiq 'internal sqd lag metric.*0|under-reports this failure mode|lag metric .*missing|lag metric.*blind spot'; then
    indexer_metric_blind_spot=1
  fi
  if printf '%s\n' "$combined" | grep -Eiq 'no cpu/memory requests|no cpu/memory reservations|resource contention|99% requested cpu|temporary resource bump|explicit cpu/memory reservations'; then
    indexer_resources_missing=1
  fi
  if printf '%s\n' "$combined" | grep -Eiq 'create-historical-rewards-state|state materialization backlog|queue backlog|bullmq backlog|long-running .*historical rewards'; then
    indexer_queue_backlog=1
  fi
  if printf '%s\n' "$combined" | grep -Eiq 'eth_getlogs.*block not found|not yet available on the node|rpc availability mismatch|erpc head jitter|erpc head age|rpc/e?rpc'; then
    indexer_rpc_mismatch=1
  fi

  current_ts="$(date +%s 2>/dev/null || echo 0)"
  if [[ "$current_ts" =~ ^[0-9]+$ ]] && [[ -n "$indexer_workloads" ]]; then
    cutoff_ts=$((current_ts - 86400))
    indexer_recent_match_count="$(count_recent_matching_incidents "$indexer_workloads" "$cutoff_ts")"
    if [[ "$indexer_recent_match_count" =~ ^[0-9]+$ ]] && [[ "$indexer_recent_match_count" -ge 3 ]]; then
      indexer_recurring_incident=1
    fi
  fi
  if printf '%s\n' "$combined" | grep -Eiq 'repeated|re-fired|fires often|same issue|again|flapped|recurring'; then
    indexer_recurring_incident=1
  fi

  if [[ "$indexer_resources_missing" -eq 1 || "$indexer_processed_vs_head_rate_gap" -eq 1 || "$indexer_queue_backlog" -eq 1 || "$indexer_recurring_incident" -eq 1 || "$indexer_metric_blind_spot" -eq 1 ]]; then
    indexer_canonical_category_hint="scaling_issue"
  elif [[ "$indexer_rpc_mismatch" -eq 1 ]]; then
    indexer_canonical_category_hint="dependency_failure"
  elif [[ "$indexer_db_vs_live_head_gap" -eq 1 ]]; then
    indexer_canonical_category_hint="scaling_issue"
  fi

  if [[ "$indexer_db_vs_live_head_gap" -eq 1 || "$indexer_processed_vs_head_rate_gap" -eq 1 || "$indexer_metric_blind_spot" -eq 1 || "$indexer_resources_missing" -eq 1 || "$indexer_queue_backlog" -eq 1 || "$indexer_rpc_mismatch" -eq 1 || "$indexer_recurring_incident" -eq 1 ]]; then
    indexer_freshness_note="signals_ready"
  fi
}

build_phase3_gap_input_file() {
  local target_file="$1"
  cat >"$target_file" <<EOF
pod_issues=${pod_issue_count:-0}
deploy_gaps=${deploy_gap_count:-0}
critical_alerts=${critical_alert_count:-0}
log_signals=${log_signal_count:-0}
prom_critical=${prom_trend_critical_count:-0}
argocd_sync=${argocd_critical_count:-0}
cert_critical=${cert_health_critical_count:-0}
aws_critical=${aws_signal_critical_count:-0}
image_revision=$( [[ -n "${image_revision_output:-}" ]] && printf 1 || printf 0 )
ci_signal=$( [[ -n "${ci_status_output:-}" ]] && printf 1 || printf 0 )
changes_in_window=$( [[ -n "${changes_in_window_summary:-}" ]] && printf 1 || printf 0 )
config_drift=$( [[ -n "${config_drift_output:-}" ]] && printf 1 || printf 0 )
config_lineage=$( [[ -n "${config_lineage_output:-}" ]] && printf 1 || printf 0 )
incident_memory=$( [[ -n "${linear_memory_output:-}" ]] && printf 1 || printf 0 )
db_schema_check=${db_schema_check:-0}
db_data_check=${db_data_check:-0}
pg_internal_check=${pg_internal_check:-0}
replica_lag=${replica_lag:-0}
pg_activity=${pg_activity:-0}
pg_statements=${pg_statements:-0}
pg_conflicts=${pg_conflicts:-0}
db_topology=${db_topology:-0}
rewards_provider_mode=${rewards_provider_mode:-0}
db_row_provenance=${db_row_provenance:-0}
provider_api_check=${provider_api_check:-0}
provider_side_mismatch=${provider_side_mismatch:-0}
artifact_check=${artifact_check:-0}
code_path_check=${code_path_check:-0}
code_path_reconciled=${code_path_reconciled:-0}
disproved_theory_recorded=${disproved_theory_recorded:-0}
disproved_theory_expected=${disproved_theory_expected:-0}
same_token_both_sides_expected=${same_token_both_sides_expected:-0}
indexer_freshness_mode=${indexer_freshness_mode:-0}
db_vs_live_head_gap=${indexer_db_vs_live_head_gap:-0}
processed_vs_head_rate_gap=${indexer_processed_vs_head_rate_gap:-0}
metric_blind_spot=${indexer_metric_blind_spot:-0}
resources_missing=${indexer_resources_missing:-0}
queue_backlog=${indexer_queue_backlog:-0}
rpc_mismatch=${indexer_rpc_mismatch:-0}
recurring_incident=${indexer_recurring_incident:-0}
EOF
}

run_phase3_recollection_loop() {
  local category="$1"
  local evidence_bundle_ref="$2"
  local attempts=0 start_ms current_ms elapsed_ms
  local gap_file gap_json collectors recollect_note recollect_rerun_json

  [[ "$incident" -eq 1 ]] || return 0
  [[ "$HAS_LIB_EVIDENCE_GAPS" -eq 1 && "$HAS_LIB_HYPOTHESIS_RECOLLECT" -eq 1 ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  declare -F evidence_gaps_assess >/dev/null 2>&1 || return 0
  declare -F hypothesis_recollect_should_run >/dev/null 2>&1 || return 0
  declare -F hypothesis_recollect_collectors >/dev/null 2>&1 || return 0
  declare -F hypothesis_recollect_note >/dev/null 2>&1 || return 0

  start_ms="$(now_ms)"
  gap_file="$(mktemp "${TMPDIR:-/tmp}/openclaw-sre-gap-input.XXXXXX")"
  trap 'rm -f "$gap_file"' RETURN

  while true; do
    build_phase3_gap_input_file "$gap_file"
    gap_json="$(evidence_gaps_assess "$category" "$gap_file" 2>/dev/null || true)"
    current_ms="$(now_ms)"
    elapsed_ms=$((current_ms - start_ms))
    if ! hypothesis_recollect_should_run "${rca_confidence:-0}" "${gap_json:-{}}" "$attempts" "$elapsed_ms"; then
      evidence_gap_json="${gap_json:-}"
      evidence_gap_status="final"
      return 0
    fi

    attempts=$((attempts + 1))
    evidence_gap_json="${gap_json:-}"
    evidence_gap_status="recollecting"
    collectors="$(hypothesis_recollect_collectors "${gap_json:-{}}" 2>/dev/null || true)"
    recollect_note="$(hypothesis_recollect_note "$category" "${gap_json:-{}}" "$attempts" 2>/dev/null || true)"
    recollect_events="${recollect_events:-}${recollect_note}"$'\n'

    while IFS= read -r collector; do
      [[ -n "$collector" ]] || continue
      case "$collector" in
        step_01_pod_deploy)
          STEP_OUTPUT_01="$(step_01_pod_deploy 2>/dev/null || true)"; STEP_STATUS_01="ok"; apply_step_output 01
          ;;
        step_02_events_alerts)
          STEP_OUTPUT_02="$(step_02_events_alerts 2>/dev/null || true)"; STEP_STATUS_02="ok"; apply_step_output 02
          ;;
        step_03_prometheus_trends)
          STEP_OUTPUT_03="$(step_03_prometheus_trends 2>/dev/null || true)"; STEP_STATUS_03="ok"; apply_step_output 03
          ;;
        step_04_argocd_sync)
          STEP_OUTPUT_04="$(step_04_argocd_sync 2>/dev/null || true)"; STEP_STATUS_04="ok"; apply_step_output 04
          ;;
        step_06_cert_secret_health)
          STEP_OUTPUT_06="$(step_06_cert_secret_health 2>/dev/null || true)"; STEP_STATUS_06="ok"; apply_step_output 06
          ;;
        step_07_aws_resource_signals)
          STEP_OUTPUT_07="$(step_07_aws_resource_signals 2>/dev/null || true)"; STEP_STATUS_07="ok"; apply_step_output 07
          ;;
        step_09_revisions)
          STEP_OUTPUT_09="$(step_09_revisions 2>/dev/null || true)"; STEP_STATUS_09="ok"; apply_step_output 09
          ;;
        step_10_ci_signals)
          STEP_OUTPUT_10="$(step_10_ci_signals 2>/dev/null || true)"; STEP_STATUS_10="ok"; apply_step_output 10
          ;;
        collect_phase2_db_evidence)
          collect_phase2_db_evidence
          ;;
        collect_change_window_context)
          collect_change_window_context
          ;;
        collect_phase2_drift_and_lineage)
          collect_phase2_drift_and_lineage
          ;;
      esac
    done <<<"$collectors"

    export RCA_RECOLLECT_NOTE="$recollect_note"
    recollect_rerun_json="$(run_step_11 "$evidence_bundle_ref" "$rca_mode_effective" "incident" "$linear_memory_output" "" 2>/dev/null || true)"
    unset RCA_RECOLLECT_NOTE
    if [[ -n "$recollect_rerun_json" ]] && printf '%s\n' "$recollect_rerun_json" | jq -e . >/dev/null 2>&1; then
      rca_result_json="$(printf '%s\n' "$recollect_rerun_json" | jq -c \
        --arg note "$recollect_note" \
        --argjson attempt "$attempts" \
        '.chain_metadata = (.chain_metadata // {})
         | .chain_metadata.recollection = {
             attempt: $attempt,
             note: $note
           }')"
      rca_confidence="$(printf '%s\n' "$rca_result_json" | jq -r '.merged_confidence // .hypotheses[0].confidence // .confidence // 40')"
      [[ "$rca_confidence" =~ ^[0-9]+([.][0-9]+)?$ ]] || rca_confidence="40"
      rca_summary="$(sanitize_signal_line "$(printf '%s\n' "$rca_result_json" | jq -r '.summary // .brief_description // .hypotheses[0].description // empty')")"
      rca_root_cause="$(sanitize_signal_line "$(printf '%s\n' "$rca_result_json" | jq -r '.root_cause // .hypotheses[0].description // empty')")"
      rca_degradation_note="$(sanitize_signal_line "$(printf '%s\n' "$rca_result_json" | jq -r '.degradation_note // empty')")"
      rca_result_source="llm_recollect"
      rca_result_status="ok"
    fi
  done
}

run_step 01 "pod_deploy" "$STEP_TIMEOUT_POD_DEPLOY_SECONDS" yes "$(step_command step_01_pod_deploy)" || {
  emit_abort_output "Core cluster signals unavailable (Step 1)" "01"
  exit 0
}
apply_step_output 01

run_step 02 "events_alerts" "$STEP_TIMEOUT_EVENTS_ALERTS_SECONDS" yes "$(step_command step_02_events_alerts)" || {
  emit_abort_output "Core cluster signals unavailable (Step 2)" "02"
  exit 0
}
apply_step_output 02
EVIDENCE_BUDGET_START_MS="$(now_ms)"

LINEAR_MEMORY_QUERY="$(
  {
    printf 'namespaces:%s ' "$SCOPE_NAMESPACES"
    printf '%s\n' "$pod_rows" | sed -n '1,2p' | awk -F'\t' 'NF >= 2 { print $1 "/" $2 }'
    printf '%s\n' "$event_rows" | sed -n '1,2p' | awk -F'\t' 'NF >= 3 { print $1 ":" $3 }'
  } | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^ | $//g'
)"
export LINEAR_MEMORY_QUERY
if optional_evidence_step_allowed 00; then
  run_step 00 "linear_memory" "$STEP_TIMEOUT_LINEAR_MEMORY_SECONDS" no "$(step_command step_00_linear_memory)"
  apply_step_output 00
fi
linear_memory_status="${linear_memory_status:-skipped}"
linear_memory_rows_count="${linear_memory_rows_count:-0}"
linear_memory_note="${linear_memory_note:-none}"
linear_memory_output="${linear_memory_output:-}"

if optional_evidence_step_allowed 03; then
  run_step 03 "prometheus_trends" "$STEP_TIMEOUT_PROMETHEUS_TRENDS_SECONDS" no "$(step_command step_03_prometheus_trends)"
  apply_step_output 03
fi
prometheus_trends_output="${STEP_OUTPUT_03:-}"
prom_trend_critical_count="${prom_trend_critical_count:-0}"
prom_trend_warning_count="${prom_trend_warning_count:-0}"
prom_trend_note="${prom_trend_note:-none}"

if optional_evidence_step_allowed 04; then
  run_step 04 "argocd_sync" "$STEP_TIMEOUT_ARGOCD_SYNC_SECONDS" no "$(step_command step_04_argocd_sync)"
  apply_step_output 04
fi
argocd_sync_output="${STEP_OUTPUT_04:-}"
argocd_critical_count="${argocd_critical_count:-0}"
argocd_warning_count="${argocd_warning_count:-0}"
argocd_note="${argocd_note:-none}"

pod_issue_count="$(count_lines "$pod_rows")"
container_failure_count="$(count_lines "$container_state_rows")"
deploy_gap_count="$(count_lines "$deploy_rows")"
event_count="$(count_lines "$event_rows")"
alert_count="$(count_lines "$alert_rows")"

missing_secret_rows="$(
  printf '%s\n' "$event_rows" \
    | awk -F'\t' 'tolower($5) ~ /secret "[^"]+" not found/ { print $0 }' \
    | sort -u
)" || missing_secret_rows=""
missing_secret_count="$(count_lines "$missing_secret_rows")"

missing_configmap_rows="$(
  printf '%s\n' "$event_rows" \
    | awk -F'\t' 'tolower($5) ~ /configmap "[^"]+" not found/ { print $0 }' \
    | sort -u
)" || missing_configmap_rows=""
missing_configmap_count="$(count_lines "$missing_configmap_rows")"

create_config_rows="$(
  printf '%s\n' "$pod_rows" \
    | awk -F'\t' '$5 ~ /CreateContainerConfigError/ { print $0 }' \
    | sort -u
)" || create_config_rows=""
create_config_count="$(count_lines "$create_config_rows")"

image_pull_rows="$(
  printf '%s\n' "$pod_rows" \
    | awk -F'\t' '$5 ~ /ImagePullBackOff|ErrImagePull/ { print $0 }' \
    | sort -u
)" || image_pull_rows=""
image_pull_count="$(count_lines "$image_pull_rows")"

crashloop_rows="$(
  printf '%s\n' "$container_state_rows" \
    | awk -F'\t' '$7 ~ /CrashLoopBackOff|OOMKilled/ { print $1 "\t" $2 "\t" $3 "\t" $7 "\t" $8 "\t" $9 }' \
    | sort -u
)" || crashloop_rows=""
crashloop_count="$(count_lines "$crashloop_rows")"

oom_killed_rows="$(
  printf '%s\n' "$container_state_rows" \
    | awk -F'\t' '$7 == "OOMKilled" { print $1 "\t" $2 "\t" $3 "\t" $8 "\t" $9 }' \
    | sort -u
)" || oom_killed_rows=""
oom_killed_count="$(count_lines "$oom_killed_rows")"

nonzero_exit_rows="$(
  printf '%s\n' "$container_state_rows" \
    | awk -F'\t' '$8 ~ /^[0-9]+$/ && $8 > 0 { print $1 "\t" $2 "\t" $3 "\t" $7 "\t" $8 "\t" $9 }' \
    | sort -u
)" || nonzero_exit_rows=""
nonzero_exit_count="$(count_lines "$nonzero_exit_rows")"

export container_state_rows
if optional_evidence_step_allowed 05; then
  run_step 05 "log_signals" "$STEP_TIMEOUT_LOG_SIGNALS_SECONDS" no "$(step_command step_05_log_signals)"
  apply_step_output 05
fi
log_signal_rows="${log_signal_rows:-}"
log_signal_count="${log_signal_count:-0}"
log_authz_count="${log_authz_count:-0}"
log_network_count="${log_network_count:-0}"
log_tls_count="${log_tls_count:-0}"
log_crash_count="${log_crash_count:-0}"
log_oom_count="${log_oom_count:-0}"

collect_phase2_db_evidence
db_evidence_status="${db_evidence_status:-skipped}"
db_evidence_note="${db_evidence_note:-disabled}"
db_evidence_target="${db_evidence_target:-}"
db_evidence_rows="${db_evidence_rows:-}"
db_schema_check="${db_schema_check:-0}"
db_data_check="${db_data_check:-0}"
pg_internal_check="${pg_internal_check:-0}"
replica_lag="${replica_lag:-0}"
pg_activity="${pg_activity:-0}"
pg_statements="${pg_statements:-0}"
pg_conflicts="${pg_conflicts:-0}"
db_topology="${db_topology:-0}"

if optional_evidence_step_allowed 06; then
  run_step 06 "cert_secret_health" "$STEP_TIMEOUT_CERT_SECRET_HEALTH_SECONDS" no "$(step_command step_06_cert_secret_health)"
  apply_step_output 06
fi
cert_secret_health_output="${STEP_OUTPUT_06:-}"
cert_health_critical_count="${cert_health_critical_count:-0}"
cert_health_warning_count="${cert_health_warning_count:-0}"
cert_health_note="${cert_health_note:-none}"

if optional_evidence_step_allowed 07; then
  run_step 07 "aws_resource_signals" "$STEP_TIMEOUT_AWS_RESOURCE_SIGNALS_SECONDS" no "$(step_command step_07_aws_resource_signals)"
  apply_step_output 07
fi
aws_resource_signals_output="${STEP_OUTPUT_07:-}"
aws_signal_critical_count="${aws_signal_critical_count:-0}"
aws_signal_warning_count="${aws_signal_warning_count:-0}"
aws_signal_note="${aws_signal_note:-none}"

hpa_metrics_rows="$(
  printf '%s\n' "$event_rows" \
    | awk -F'\t' '$2 ~ /^HorizontalPodAutoscaler\// && tolower($5) ~ /pods.metrics.k8s.io/ { print $0 }' \
    | sort -u
)" || hpa_metrics_rows=""
hpa_metrics_count="$(count_lines "$hpa_metrics_rows")"

finding_cluster_rows="$(
  printf '%s\n' "$event_rows" \
    | awk -F'\t' '$3 == "FindingCluster" && tolower($5) ~ /unknown cluster/ { print $0 }' \
    | sort -u
)" || finding_cluster_rows=""
finding_cluster_count="$(count_lines "$finding_cluster_rows")"

critical_alert_count="$(
  printf '%s\n' "$alert_rows" | awk -F'\t' 'tolower($1) == "critical" { c++ } END { print c + 0 }'
)"
warning_alert_count="$(
  printf '%s\n' "$alert_rows" | awk -F'\t' 'tolower($1) == "warning" { c++ } END { print c + 0 }'
)"

primary_pod_issue_count="$(count_tsv_in_namespaces "$pod_rows" "$PRIMARY_NAMESPACES" 1)"
primary_container_failure_count="$(count_tsv_in_namespaces "$container_state_rows" "$PRIMARY_NAMESPACES" 1)"
primary_deploy_gap_count="$(count_tsv_in_namespaces "$deploy_rows" "$PRIMARY_NAMESPACES" 1)"
primary_missing_secret_count="$(count_tsv_in_namespaces "$missing_secret_rows" "$PRIMARY_NAMESPACES" 1)"
primary_missing_configmap_count="$(count_tsv_in_namespaces "$missing_configmap_rows" "$PRIMARY_NAMESPACES" 1)"
primary_create_config_count="$(count_tsv_in_namespaces "$create_config_rows" "$PRIMARY_NAMESPACES" 1)"
primary_image_pull_count="$(count_tsv_in_namespaces "$image_pull_rows" "$PRIMARY_NAMESPACES" 1)"
primary_crashloop_count="$(count_tsv_in_namespaces "$crashloop_rows" "$PRIMARY_NAMESPACES" 1)"
primary_oom_killed_count="$(count_tsv_in_namespaces "$oom_killed_rows" "$PRIMARY_NAMESPACES" 1)"
primary_nonzero_exit_count="$(count_tsv_in_namespaces "$nonzero_exit_rows" "$PRIMARY_NAMESPACES" 1)"
primary_log_signal_count="$(count_tsv_in_namespaces "$log_signal_rows" "$PRIMARY_NAMESPACES" 1)"

critical_alert_rows="$(
  printf '%s\n' "$alert_rows" | awk -F'\t' 'tolower($1) == "critical" { print }'
)" || critical_alert_rows=""
primary_critical_alert_count="$(count_tsv_in_namespaces "$critical_alert_rows" "$PRIMARY_NAMESPACES" 3)"

primary_impact_signals=$(( \
  primary_pod_issue_count + \
  primary_container_failure_count + \
  primary_deploy_gap_count + \
  primary_missing_secret_count + \
  primary_missing_configmap_count + \
  primary_create_config_count + \
  primary_image_pull_count + \
  primary_crashloop_count + \
  primary_oom_killed_count + \
  primary_nonzero_exit_count + \
  primary_log_signal_count + \
  primary_critical_alert_count \
))

supporting_pod_issue_count=$((pod_issue_count - primary_pod_issue_count))
if [[ "$supporting_pod_issue_count" -lt 0 ]]; then
  supporting_pod_issue_count=0
fi
supporting_container_failure_count=$((container_failure_count - primary_container_failure_count))
if [[ "$supporting_container_failure_count" -lt 0 ]]; then
  supporting_container_failure_count=0
fi
supporting_log_signal_count=$((log_signal_count - primary_log_signal_count))
if [[ "$supporting_log_signal_count" -lt 0 ]]; then
  supporting_log_signal_count=0
fi
supporting_deploy_gap_count=$((deploy_gap_count - primary_deploy_gap_count))
if [[ "$supporting_deploy_gap_count" -lt 0 ]]; then
  supporting_deploy_gap_count=0
fi
supporting_critical_alert_count=$((critical_alert_count - primary_critical_alert_count))
if [[ "$supporting_critical_alert_count" -lt 0 ]]; then
  supporting_critical_alert_count=0
fi

warning_alert_points=$((warning_alert_count * 3))
if [[ "$warning_alert_points" -gt 30 ]]; then
  warning_alert_points=30
fi

finding_cluster_points="$finding_cluster_count"
if [[ "$finding_cluster_points" -gt 10 ]]; then
  finding_cluster_points=10
fi

event_noise_points=$((event_count / 40))
if [[ "$event_noise_points" -gt 8 ]]; then
  event_noise_points=8
fi

container_failure_points=$((container_failure_count * 2))
if [[ "$container_failure_points" -gt 20 ]]; then
  container_failure_points=20
fi

log_signal_points=$((log_signal_count * 2))
if [[ "$log_signal_points" -gt 16 ]]; then
  log_signal_points=16
fi

prom_trend_points=$((prom_trend_critical_count * 15 + prom_trend_warning_count * 5))
if [[ "$prom_trend_points" -gt 30 ]]; then
  prom_trend_points=30
fi

argocd_points=$((argocd_critical_count * 12 + argocd_warning_count * 6))
if [[ "$argocd_points" -gt 24 ]]; then
  argocd_points=24
fi

cert_health_points=$((cert_health_critical_count * 10 + cert_health_warning_count * 4))
if [[ "$cert_health_points" -gt 20 ]]; then
  cert_health_points=20
fi

aws_signal_points=$((aws_signal_critical_count * 10 + aws_signal_warning_count * 4))
if [[ "$aws_signal_points" -gt 20 ]]; then
  aws_signal_points=20
fi

severity_score=$(( \
  create_config_count * 35 + \
  missing_secret_count * 25 + \
  missing_configmap_count * 20 + \
  image_pull_count * 30 + \
  crashloop_count * 15 + \
  oom_killed_count * 12 + \
  nonzero_exit_count * 4 + \
  deploy_gap_count * 12 + \
  critical_alert_count * 25 + \
  warning_alert_points + \
  hpa_metrics_count * 8 + \
  finding_cluster_points + \
  event_noise_points + \
  container_failure_points + \
  log_signal_points + \
  prom_trend_points + \
  argocd_points + \
  cert_health_points + \
  aws_signal_points \
))

if [[ "$severity_score" -gt 100 ]]; then
  severity_score=100
fi

severity_level="low"
severity_reason="low-signal"
if [[ "$primary_critical_alert_count" -gt 0 ]] || [[ "$primary_create_config_count" -gt 0 && "$primary_deploy_gap_count" -gt 0 ]] || [[ "$primary_image_pull_count" -gt 0 && "$primary_deploy_gap_count" -gt 0 ]]; then
  severity_level="critical"
  severity_reason="hard-failure-pattern"
elif [[ "$severity_score" -ge "$SEVERITY_CRITICAL_SCORE" ]]; then
  severity_level="critical"
  severity_reason="score-gte-critical-threshold"
elif [[ "$severity_score" -ge "$SEVERITY_HIGH_SCORE" ]]; then
  severity_level="high"
  severity_reason="score-gte-high-threshold"
elif [[ "$severity_score" -ge "$SEVERITY_MEDIUM_SCORE" ]]; then
  severity_level="medium"
  severity_reason="score-gte-medium-threshold"
fi

if [[ "$primary_impact_signals" -eq 0 ]]; then
  case "$severity_level" in
    critical)
      severity_level="high"
      severity_reason="${severity_reason}+supporting-namespace-only"
      ;;
    high)
      severity_level="medium"
      severity_reason="${severity_reason}+supporting-namespace-only"
      ;;
  esac
fi

recommended_target="$ROUTE_TARGET_LOW"
recommended_mode="digest-update"
case "$severity_level" in
  critical)
    recommended_target="$ROUTE_TARGET_CRITICAL"
    recommended_mode="immediate-page"
    ;;
  high)
    recommended_target="$ROUTE_TARGET_HIGH"
    recommended_mode="priority-alert"
    ;;
  medium)
    recommended_target="$ROUTE_TARGET_MEDIUM"
    recommended_mode="channel-alert"
    ;;
  *)
    recommended_target="$ROUTE_TARGET_LOW"
    recommended_mode="digest-update"
    ;;
esac

export pod_rows
if optional_evidence_step_allowed 08; then
  run_step 08 "image_repo" "$STEP_TIMEOUT_IMAGE_REPO_SECONDS" no "$(step_command step_08_image_repo)"
  apply_step_output 08
fi
impacted_pod_keys="${impacted_pod_keys:-}"
repo_map_rows="${repo_map_rows:-}"
repo_map_note="${repo_map_note:-}"

export repo_map_rows
if optional_evidence_step_allowed 09; then
  run_step 09 "revisions" "$STEP_TIMEOUT_REVISIONS_SECONDS" no "$(step_command step_09_revisions)"
  apply_step_output 09
fi
revision_rows="${revision_rows:-}"
revision_note="${revision_note:-}"
suspect_pr_rows="${suspect_pr_rows:-}"
suspect_pr_count="${suspect_pr_count:-0}"
revision_resolved_count="${revision_resolved_count:-0}"

export repo_map_rows
if optional_evidence_step_allowed 10; then
  run_step 10 "ci_signals" "$STEP_TIMEOUT_CI_SIGNALS_SECONDS" no "$(step_command step_10_ci_signals)"
  apply_step_output 10
fi
ci_rows="${ci_rows:-}"
ci_note="${ci_note:-}"

pr_candidate_rows=""
add_pr_candidate() {
  local repo="$1"
  local reason="$2"
  local likely_files="$3"
  pr_candidate_rows="${pr_candidate_rows}${repo}"$'\t'"${reason}"$'\t'"${likely_files}"$'\n'
}

if [[ "$missing_secret_count" -gt 0 || "$create_config_count" -gt 0 || "$missing_configmap_count" -gt 0 ]]; then
  add_pr_candidate \
    "morpho-org/morpho-infra-helm" \
    "missing secret/config references in workload manifests" \
    "charts/**/values*.yaml; charts/**/templates/*.yaml"
  add_pr_candidate \
    "morpho-org/morpho-infra" \
    "secret source or external secret definitions mismatch" \
    "projects/**/kubernetes/**/externalsecret*.yaml; terraform secret mappings"
fi

if [[ "$oom_killed_count" -gt 0 ]]; then
  add_pr_candidate \
    "morpho-org/morpho-infra-helm" \
    "oom kills indicate resource requests/limits mismatch" \
    "charts/**/values*.yaml; charts/**/templates/deployment*.yaml"
fi

if [[ "$hpa_metrics_count" -gt 0 ]]; then
  add_pr_candidate \
    "morpho-org/morpho-infra" \
    "metrics-server/APIService health impacts HPA decisions" \
    "projects/**/kubernetes/**/metrics-server*.yaml; cluster addons values"
fi

if [[ "$finding_cluster_count" -gt 0 ]]; then
  add_pr_candidate \
    "morpho-org/morpho-infra" \
    "stale cnpg backup resources target deleted cluster" \
    "projects/**/kubernetes/**/cnpg/**/backup*.yaml"
fi

if [[ "$image_pull_count" -gt 0 || "$crashloop_count" -gt 0 ]]; then
  while IFS= read -r repo; do
    [[ -z "$repo" ]] && continue
    if [[ "$image_pull_count" -gt 0 ]]; then
      add_pr_candidate \
        "$repo" \
        "image tag/auth mismatch from deployment rollout" \
        "helm/values*.yaml; deployment manifests; image tag config"
    fi
    if [[ "$crashloop_count" -gt 0 ]]; then
      add_pr_candidate \
        "$repo" \
        "runtime regression or startup config mismatch" \
        "src/**; config/**; Dockerfile; helm/**"
    fi
  done < <(
    printf '%s\n' "$repo_map_rows" \
      | awk -F'\t' 'NF >= 4 && $4 != "" { print $4 }' \
      | sort -u
  )
fi

if [[ "$suspect_pr_count" -gt 0 ]]; then
  while IFS=$'\t' read -r repo pr_number pr_title _pr_state _pr_url _ns _pod; do
    [[ -z "$repo" || -z "$pr_number" || "$pr_number" == "-" ]] && continue
    add_pr_candidate \
      "$repo" \
      "suspect deployed PR #${pr_number}: ${pr_title}" \
      "review PR diff + deployment config deltas; compare release timestamp and incident start"
  done < <(printf '%s\n' "$suspect_pr_rows")
fi

step11_dedup_namespace="$(printf '%s' "$SCOPE_NAMESPACES" | awk -F',' '{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $1); print ($1 == "" ? "unknown" : $1)}')"
step11_category_hint="${indexer_canonical_category_hint:-}"
if [[ -z "$step11_category_hint" || "$step11_category_hint" == "unknown" ]]; then
  step11_category_hint="${severity_reason:-unknown}"
fi
step11_dedup_category="$(printf '%s' "$step11_category_hint" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9._-' '-')"
if [[ -z "$step11_dedup_category" ]]; then
  step11_dedup_category="unknown"
fi
step11_workloads="$(derive_step11_workloads "${deploy_rows:-}" "${pod_rows:-}" 2>/dev/null || true)"
step11_primary_service="$(printf '%s\n' "${step11_workloads:-}" | awk -F'|' 'NF > 0 && $1 != "" { print $1; exit }')"
if [[ -z "$step11_primary_service" ]]; then
  step11_primary_service="unknown"
fi
step11_dedup_key="$(compute_dedup_key "$step11_dedup_namespace" "$step11_dedup_category" "$step11_workloads")"
step11_lease_acquired=0
if [[ ! -f "${SPOOL_DIR}/${step11_dedup_key}.ack" ]]; then
  if acquire_lease "$step11_dedup_key"; then
    step11_lease_acquired=1
  fi
fi

if [[ "${SERVICE_CONTEXT_ENABLED:-0}" == "1" && "$HAS_LIB_SERVICE_GRAPH" -eq 1 ]] && declare -F discover_service_graph >/dev/null 2>&1; then
  service_graph_namespaces=()
  while IFS= read -r ns; do
    [[ -z "$ns" ]] && continue
    service_graph_namespaces+=("$ns")
  done < <(split_csv_atoms "$SCOPE_NAMESPACES")
  if [[ "${#service_graph_namespaces[@]}" -eq 0 ]]; then
    service_graph_namespaces=("unknown")
  fi
  service_graph_output="$(discover_service_graph "${service_graph_namespaces[@]}" 2>/dev/null || true)"
  if [[ -n "$service_graph_output" ]] && declare -F write_service_graph >/dev/null 2>&1; then
    write_service_graph "$service_graph_output" >/dev/null 2>&1 || true
  fi
fi

declare -a HYPOTHESES=()
HYP_SEP=$'\x1f'

add_hypothesis() {
  local score="$1"
  local confidence="$2"
  local title="$3"
  local evidence="$4"
  local check="$5"
  local rollback="$6"
  HYPOTHESES+=("${score}${HYP_SEP}${confidence}${HYP_SEP}${title}${HYP_SEP}${evidence}${HYP_SEP}${check}${HYP_SEP}${rollback}")
}

if [[ "$missing_secret_count" -gt 0 || "$create_config_count" -gt 0 ]]; then
  add_hypothesis \
    "95" \
    "high" \
    "Missing secret/config reference" \
    "pod CreateContainerConfigError=${create_config_count}, missing secret events=${missing_secret_count}" \
    "kubectl --context <context> -n <ns> describe pod <pod>; kubectl --context <context> -n <ns> get deploy <name> -o yaml | rg -n 'secret|configMap'" \
    "Restore previous secretRef/configMapRef and rollout previous manifest"
fi

if [[ "$image_pull_count" -gt 0 ]]; then
  add_hypothesis \
    "90" \
    "high" \
    "Image pull failure (registry/tag/auth)" \
    "pods with ImagePullBackOff/ErrImagePull=${image_pull_count}" \
    "kubectl --context <context> -n <ns> describe pod <pod>; check image tag and imagePullSecrets; verify ECR/GHCR auth" \
    "Rollback deployment to last known-good image tag"
fi

if [[ "$crashloop_count" -gt 0 ]]; then
  add_hypothesis \
    "85" \
    "high" \
    "Application runtime crash or bad startup config" \
    "pods with CrashLoop/OOM signatures=${crashloop_count}" \
    "kubectl --context <context> -n <ns> logs <pod> --previous --tail=200; compare env/config delta vs last good release" \
    "Rollback deployment/canary to previous revision"
fi

if [[ "$revision_resolved_count" -gt 0 && "$suspect_pr_count" -gt 0 ]]; then
  add_hypothesis \
    "83" \
    "high" \
    "Recently deployed PR likely introduced runtime regression" \
    "resolved image revisions=${revision_resolved_count}, suspect PRs=${suspect_pr_count}" \
    "inspect suspect_prs section; compare PR merge and rollout timestamps; validate config/code delta against failing path" \
    "Rollback workload image to pre-incident tag/commit and monitor recovery"
fi

if [[ "$oom_killed_count" -gt 0 ]]; then
  add_hypothesis \
    "82" \
    "high" \
    "Container OOMKilled under current limits" \
    "containers with OOMKilled=${oom_killed_count}" \
    "kubectl --context <context> -n <ns> top pod <pod>; kubectl --context <context> -n <ns> get deploy <name> -o yaml | rg -n 'resources:'" \
    "Temporarily increase limits/requests or rollback to previous resource profile"
fi

if [[ "$log_authz_count" -gt 0 ]]; then
  add_hypothesis \
    "80" \
    "high" \
    "Runtime authorization failure (RBAC/credentials) seen in container logs" \
    "authz log signals=${log_authz_count}" \
    "kubectl --context <context> -n <ns> logs <pod> -c <container> --previous --tail=200; verify serviceAccount RBAC, Vault/Argo token scopes, and mounted credentials" \
    "Revert credential/role changes; roll back to last known-good secret or service account mapping"
fi

if [[ "$log_network_count" -gt 0 || "$log_tls_count" -gt 0 ]]; then
  add_hypothesis \
    "72" \
    "medium" \
    "Network/TLS dependency failure surfaced in application logs" \
    "network log signals=${log_network_count}, tls log signals=${log_tls_count}" \
    "kubectl --context <context> -n <ns> logs <pod> -c <container> --tail=200; check Service/Endpoint DNS, NetworkPolicy, and cert trust chain" \
    "Route traffic to healthy backend, revert cert/config rollout, or rollback release"
fi

if [[ "$log_crash_count" -gt 0 ]]; then
  add_hypothesis \
    "74" \
    "medium" \
    "Unhandled application exception/panic in runtime logs" \
    "crash log signals=${log_crash_count}" \
    "capture stack traces from logs, map image tag to commit, inspect recent code path changes in mapped repo" \
    "Roll back deployment image/tag while preparing focused code fix"
fi

if [[ "$deploy_gap_count" -gt 0 ]]; then
  add_hypothesis \
    "75" \
    "medium" \
    "Deployment rollout stuck or unavailable replicas" \
    "deployments with readiness gaps=${deploy_gap_count}" \
    "kubectl --context <context> -n <ns> rollout status deploy/<name>; kubectl --context <context> -n <ns> describe deploy/<name>" \
    "Rollback rollout history to previous revision"
fi

if [[ "$hpa_metrics_count" -gt 0 ]]; then
  add_hypothesis \
    "65" \
    "medium" \
    "Metrics API unavailable for HPA" \
    "HPA events with pods.metrics.k8s.io missing=${hpa_metrics_count}" \
    "kubectl --context <context> get apiservice | rg metrics.k8s.io; kubectl --context <context> -n kube-system get pods | rg metrics-server" \
    "Disable impacted HPA or pin replicas until metrics API recovers"
fi

if [[ "$finding_cluster_count" -gt 0 ]]; then
  add_hypothesis \
    "60" \
    "medium" \
    "Stale CNPG backup resources target unknown cluster" \
    "FindingCluster unknown-cluster events=${finding_cluster_count}" \
    "kubectl --context <context> -n <ns> get backup,scheduledbackup | rg <cluster-name>" \
    "Remove/update stale backup CRs for deleted cluster"
fi

if [[ "$critical_alert_count" -gt 0 ]]; then
  add_hypothesis \
    "55" \
    "medium" \
    "Active critical alert set requires immediate validation" \
    "critical firing alerts (filtered)=${critical_alert_count}" \
    "query alert labels in Prometheus/Grafana; validate impacted workloads first" \
    "Silence only after confirming false positive"
fi

incident=0
if [[ "$pod_issue_count" -gt 0 || "$deploy_gap_count" -gt 0 || "$critical_alert_count" -gt 0 || "$image_pull_count" -gt 0 || "$create_config_count" -gt 0 || "$log_authz_count" -gt 0 || "$log_crash_count" -gt 0 || "$prom_trend_critical_count" -gt 0 || "$argocd_critical_count" -gt 0 || "$cert_health_critical_count" -gt 0 || "$aws_signal_critical_count" -gt 0 ]]; then
  incident=1
fi

pod_signature_rows="$(
  printf '%s\n' "$pod_rows" \
    | awk -F'\t' 'NF >= 5 { print $1 "\t" $2 "\t" $3 "\t" $5 }' \
    | sort -u
)" || pod_signature_rows=""

container_signature_rows="$(
  printf '%s\n' "$container_state_rows" \
    | awk -F'\t' 'NF >= 8 { print $1 "\t" $2 "\t" $3 "\t" $6 "\t" $7 "\t" $8 }' \
    | sort -u
)" || container_signature_rows=""

deploy_signature_rows="$(
  printf '%s\n' "$deploy_rows" \
    | awk -F'\t' 'NF >= 6 { print $1 "\t" $2 "\t" $3 "\t" $4 "\t" $6 }' \
    | sort -u
)" || deploy_signature_rows=""

alert_signature_rows="$(
  printf '%s\n' "$alert_rows" \
    | awk -F'\t' 'NF >= 5 { print $1 "\t" $2 "\t" $3 "\t" $4 "\t" $5 }' \
    | sort -u
)" || alert_signature_rows=""

missing_secret_signature_rows="$(
  printf '%s\n' "$missing_secret_rows" \
    | awk -F'\t' '
        NF >= 5 {
          ref_name="unknown"
          if (match($5, /secret "[^"]+"/)) {
            raw=substr($5, RSTART, RLENGTH)
            gsub(/^secret "/, "", raw)
            gsub(/"$/, "", raw)
            ref_name=raw
          }
          print $1 "\t" $2 "\t" ref_name
        }
      ' \
    | sort -u
)" || missing_secret_signature_rows=""

missing_configmap_signature_rows="$(
  printf '%s\n' "$missing_configmap_rows" \
    | awk -F'\t' '
        NF >= 5 {
          cm="unknown"
          if (match($5, /configmap "[^"]+"/)) {
            raw=substr($5, RSTART, RLENGTH)
            gsub(/^configmap "/, "", raw)
            gsub(/"$/, "", raw)
            cm=raw
          }
          print $1 "\t" $2 "\t" cm
        }
      ' \
    | sort -u
)" || missing_configmap_signature_rows=""

log_signal_signature_rows="$(
  printf '%s\n' "$log_signal_rows" \
    | awk -F'\t' 'NF >= 4 { print $1 "\t" $2 "\t" $3 "\t" $4 }' \
    | sort -u
)" || log_signal_signature_rows=""

incident_fingerprint_source="$(
  {
    printf 'scope\t%s\n' "$SCOPE_NAMESPACES"
    printf 'pod_signatures\t%s\n' "$(count_lines "$pod_signature_rows")"
    printf '%s\n' "$pod_signature_rows" | sed -n '1,30p'
    printf 'container_signatures\t%s\n' "$(count_lines "$container_signature_rows")"
    printf '%s\n' "$container_signature_rows" | sed -n '1,30p'
    printf 'deploy_signatures\t%s\n' "$(count_lines "$deploy_signature_rows")"
    printf '%s\n' "$deploy_signature_rows" | sed -n '1,20p'
    printf 'alert_signatures\t%s\n' "$(count_lines "$alert_signature_rows")"
    printf '%s\n' "$alert_signature_rows" | sed -n '1,20p'
    printf 'missing_secret\t%s\n' "$missing_secret_count"
    printf '%s\n' "$missing_secret_signature_rows"
    printf 'missing_configmap\t%s\n' "$missing_configmap_count"
    printf '%s\n' "$missing_configmap_signature_rows"
    printf 'log_signatures\t%s\n' "$(count_lines "$log_signal_signature_rows")"
    printf '%s\n' "$log_signal_signature_rows" | sed -n '1,20p'
  } | awk 'NF > 0 { print }'
)"
incident_fingerprint="$(printf '%s\n' "$incident_fingerprint_source" | cksum | awk '{print $1}')"
collect_change_window_context
collect_phase2_drift_and_lineage
collect_phase2_rewards_provider_context_if_available
collect_phase2_indexer_freshness_context

should_alert="no"
gate_reason="healthy"
cooldown_remaining_seconds=0

if [[ "$incident" -eq 1 ]]; then
  should_alert="yes"
  gate_reason="new-incident"

  state_store_ready=1
  if ! mkdir -p "$INCIDENT_STATE_DIR" 2>/dev/null; then
    state_store_ready=0
  fi
  last_fingerprint=""
  last_alert_ts=0

  if [[ "$state_store_ready" -eq 1 && -f "$INCIDENT_STATE_FILE" ]]; then
    last_fingerprint="$(awk -F'\t' '$1=="fingerprint"{print $2; exit}' "$INCIDENT_STATE_FILE" 2>/dev/null || true)"
    last_alert_ts_raw="$(awk -F'\t' '$1=="last_alert_ts"{print $2; exit}' "$INCIDENT_STATE_FILE" 2>/dev/null || true)"
    if [[ "${last_alert_ts_raw:-}" =~ ^[0-9]+$ ]]; then
      last_alert_ts="$last_alert_ts_raw"
    fi
  fi

  now_ts="$(date +%s 2>/dev/null || echo 0)"
  if [[ -n "$last_fingerprint" && "$last_fingerprint" == "$incident_fingerprint" ]]; then
    if [[ "$ALERT_COOLDOWN_SECONDS" -gt 0 && "$now_ts" =~ ^[0-9]+$ && "$last_alert_ts" -gt 0 ]]; then
      elapsed_seconds=$((now_ts - last_alert_ts))
      if [[ "$elapsed_seconds" -lt "$ALERT_COOLDOWN_SECONDS" ]]; then
        should_alert="no"
        gate_reason="cooldown-active-same-incident"
        cooldown_remaining_seconds=$((ALERT_COOLDOWN_SECONDS - elapsed_seconds))
      else
        should_alert="yes"
        gate_reason="cooldown-expired-same-incident"
      fi
    else
      should_alert="no"
      gate_reason="same-incident"
    fi
  elif [[ -n "$last_fingerprint" ]]; then
    gate_reason="incident-changed"
  fi

  if [[ "$should_alert" == "yes" && "$ALERT_MIN_INTERVAL_SECONDS" -gt 0 && "$now_ts" =~ ^[0-9]+$ && "$last_alert_ts" -gt 0 ]]; then
    elapsed_seconds=$((now_ts - last_alert_ts))
    if [[ "$elapsed_seconds" -lt "$ALERT_MIN_INTERVAL_SECONDS" ]]; then
      should_alert="no"
      gate_reason="min-interval-active"
      cooldown_remaining_seconds=$((ALERT_MIN_INTERVAL_SECONDS - elapsed_seconds))
    fi
  fi

  if [[ "$should_alert" == "yes" && "$state_store_ready" -eq 1 ]]; then
    {
      printf 'fingerprint\t%s\n' "$incident_fingerprint"
      printf 'last_alert_ts\t%s\n' "$now_ts"
    } >"$INCIDENT_STATE_FILE" 2>/dev/null || true
  elif [[ "$should_alert" == "yes" && "$state_store_ready" -eq 0 ]]; then
    gate_reason="${gate_reason}+state-store-unavailable"
  fi
fi

incident_id=""
incident_state_status="disabled"
incident_state_row=""
incident_rca_version="1"
resolved_incident_id=""
resolved_ticket_id=""
resolved_thread_ts=""
thread_archival_status="not_applicable"

if [[ "$HAS_LIB_STATE_FILE" -eq 1 ]] && declare -F state_init >/dev/null 2>&1; then
  mkdir -p "$INCIDENT_STATE_DIR" 2>/dev/null || true
  state_init "$ACTIVE_INCIDENTS_FILE" >/dev/null 2>&1 || true
  if declare -F _state_archive_init >/dev/null 2>&1; then
    _state_archive_init "$RESOLVED_INCIDENTS_FILE" >/dev/null 2>&1 || true
  fi
fi

if [[ "$incident" -eq 1 ]]; then
  betterstack_alias=""
  if [[ -n "${BETTERSTACK_INCIDENT_ID}${BETTERSTACK_THREAD_TS}${BETTERSTACK_CONTEXT}" ]]; then
    if [[ "$HAS_LIB_INCIDENT_ID" -eq 1 ]] && declare -F generate_incident_id >/dev/null 2>&1; then
      betterstack_alias="$(generate_incident_id betterstack "$BETTERSTACK_INCIDENT_ID" "$BETTERSTACK_THREAD_TS" "$BETTERSTACK_CONTEXT" 2>/dev/null || true)"
    fi
    if [[ -z "$betterstack_alias" && -n "$BETTERSTACK_INCIDENT_ID" ]]; then
      betterstack_alias="bs:${BETTERSTACK_INCIDENT_ID}"
    fi
    betterstack_alias="$(sanitize_state_field "$betterstack_alias")"
  fi

  if [[ "$HAS_LIB_INCIDENT_ID" -eq 1 ]] && declare -F generate_incident_id >/dev/null 2>&1; then
    incident_id="$(generate_incident_id heartbeat "$step11_dedup_namespace" "$step11_dedup_category" "fp${incident_fingerprint}" "$step11_workloads" 2>/dev/null || true)"
  fi
  if [[ -z "$incident_id" ]]; then
    incident_id="$(fallback_incident_id "$step11_dedup_namespace" "$step11_dedup_category" "$step11_workloads" "$incident_fingerprint")"
  fi
  incident_id="$(sanitize_state_field "$incident_id")"

  if [[ -n "$betterstack_alias" && "$HAS_LIB_STATE_FILE" -eq 1 ]] && declare -F state_read_all >/dev/null 2>&1; then
    bs_reconcile_row="$(state_read_all "$ACTIVE_INCIDENTS_FILE" 2>/dev/null | awk -F'\t' -v alias="$betterstack_alias" 'NF >= 19 && $19 == alias { print; exit }')"
    bs_reconcile_incident_id="$(sanitize_state_field "$(tsv_field "$bs_reconcile_row" 1)")"
    if [[ -n "$bs_reconcile_incident_id" ]]; then
      incident_id="$bs_reconcile_incident_id"
      gate_reason="${gate_reason}+bs-alias-reconciled"
    fi
  fi

  if [[ "$HAS_LIB_STATE_FILE" -eq 1 ]] && declare -F state_init >/dev/null 2>&1 && declare -F state_write_row >/dev/null 2>&1; then
    current_epoch="$(date +%s 2>/dev/null || echo 0)"
    mkdir -p "$INCIDENT_STATE_DIR" 2>/dev/null || true
    if state_init "$ACTIVE_INCIDENTS_FILE" >/dev/null 2>&1; then
      incident_state_status="ready"
    else
      incident_state_status="init_error"
    fi

    incident_state_row="$(state_read_incident "$incident_id" "$ACTIVE_INCIDENTS_FILE" 2>/dev/null || true)"
    existing_first_seen="$(tsv_field "$incident_state_row" 4)"
    existing_last_nonempty_ts="$(tsv_field "$incident_state_row" 6)"
    existing_rca_version="$(tsv_field "$incident_state_row" 7)"
    existing_fingerprint="$(sanitize_state_field "$(tsv_field "$incident_state_row" 8)")"
    existing_linear_ticket_id="$(sanitize_state_field "$(tsv_field "$incident_state_row" 10)")"
    existing_slack_thread_ts="$(sanitize_state_field "$(tsv_field "$incident_state_row" 11)")"
    existing_category_drift="$(sanitize_state_field "$(tsv_field "$incident_state_row" 13)")"
    existing_slack_post_status="$(sanitize_state_field "$(tsv_field "$incident_state_row" 14)")"
    existing_slack_post_attempts="$(tsv_field "$incident_state_row" 15)"
    existing_linear_post_status="$(sanitize_state_field "$(tsv_field "$incident_state_row" 16)")"
    existing_linear_post_attempts="$(tsv_field "$incident_state_row" 17)"
    existing_linear_reservation="$(sanitize_state_field "$(tsv_field "$incident_state_row" 18)")"
    existing_bs_alias="$(sanitize_state_field "$(tsv_field "$incident_state_row" 19)")"
    existing_last_primary_ts="$(tsv_field "$incident_state_row" 20)"
    existing_non_primary_streak="$(tsv_field "$incident_state_row" 21)"
    existing_category="$(sanitize_state_field "$(tsv_field "$incident_state_row" 3)")"

    if [[ "$existing_first_seen" =~ ^[0-9]+$ ]]; then
      first_seen_ts="$existing_first_seen"
    else
      first_seen_ts="$current_epoch"
    fi
    last_seen_ts="$current_epoch"

    affected_workloads="$(sanitize_state_field "$(normalize_pipe_atoms "$step11_workloads")")"
    if [[ -n "$affected_workloads" ]]; then
      last_nonempty_ts="$current_epoch"
    elif [[ "$existing_last_nonempty_ts" =~ ^[0-9]+$ ]]; then
      last_nonempty_ts="$existing_last_nonempty_ts"
    else
      last_nonempty_ts="$current_epoch"
    fi

    if [[ "$existing_rca_version" =~ ^[0-9]+$ ]]; then
      incident_rca_version="$existing_rca_version"
    else
      incident_rca_version="1"
    fi
    if [[ -n "$existing_fingerprint" && "$existing_fingerprint" != "$incident_fingerprint" ]]; then
      incident_rca_version="$((incident_rca_version + 1))"
    fi

    evidence_signal_keys_raw=""
    [[ "$pod_issue_count" -gt 0 ]] && evidence_signal_keys_raw="${evidence_signal_keys_raw}pod_issue|"
    [[ "$deploy_gap_count" -gt 0 ]] && evidence_signal_keys_raw="${evidence_signal_keys_raw}deploy_gap|"
    [[ "$critical_alert_count" -gt 0 ]] && evidence_signal_keys_raw="${evidence_signal_keys_raw}critical_alert|"
    [[ "$log_signal_count" -gt 0 ]] && evidence_signal_keys_raw="${evidence_signal_keys_raw}log_signal|"
    [[ "$prom_trend_critical_count" -gt 0 || "$prom_trend_warning_count" -gt 0 ]] && evidence_signal_keys_raw="${evidence_signal_keys_raw}prometheus_trends|"
    [[ "$argocd_critical_count" -gt 0 || "$argocd_warning_count" -gt 0 ]] && evidence_signal_keys_raw="${evidence_signal_keys_raw}argocd_sync|"
    [[ "$cert_health_critical_count" -gt 0 || "$cert_health_warning_count" -gt 0 ]] && evidence_signal_keys_raw="${evidence_signal_keys_raw}cert_secret_health|"
    [[ "$aws_signal_critical_count" -gt 0 || "$aws_signal_warning_count" -gt 0 ]] && evidence_signal_keys_raw="${evidence_signal_keys_raw}aws_resource_signals|"
    [[ "${indexer_freshness_mode:-0}" -eq 1 ]] && evidence_signal_keys_raw="${evidence_signal_keys_raw}indexer_freshness|"
    evidence_signal_keys="$(sanitize_state_field "$(normalize_pipe_atoms "${evidence_signal_keys_raw%|}")")"

    category_drift_log="$existing_category_drift"
    if [[ -n "$existing_category" && "$existing_category" != "$step11_dedup_category" ]]; then
      category_drift_log="$(sanitize_state_field "$(normalize_csv_atoms "${existing_category_drift},${existing_category},${step11_dedup_category}")")"
    fi

    if [[ "$existing_slack_post_attempts" =~ ^[0-9]+$ ]]; then
      slack_post_attempts="$existing_slack_post_attempts"
    else
      slack_post_attempts=0
    fi
    if [[ "$existing_linear_post_attempts" =~ ^[0-9]+$ ]]; then
      linear_post_attempts="$existing_linear_post_attempts"
    else
      linear_post_attempts=0
    fi
    if [[ "$existing_non_primary_streak" =~ ^[0-9]+$ ]]; then
      non_primary_streak="$existing_non_primary_streak"
    else
      non_primary_streak=0
    fi
    if [[ "$primary_impact_signals" -eq 0 ]]; then
      non_primary_streak=$((non_primary_streak + 1))
    else
      non_primary_streak=0
    fi

    if [[ "$existing_last_primary_ts" =~ ^[0-9]+$ ]]; then
      last_primary_ts="$existing_last_primary_ts"
    else
      last_primary_ts=0
    fi
    if [[ "$primary_impact_signals" -gt 0 ]]; then
      last_primary_ts="$current_epoch"
    fi

    bs_alias_value="$existing_bs_alias"
    if [[ -n "$betterstack_alias" ]]; then
      bs_alias_value="$betterstack_alias"
    fi

    incident_state_row="$(
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$incident_id" \
        "$(sanitize_state_field "$step11_dedup_namespace")" \
        "$(sanitize_state_field "$step11_dedup_category")" \
        "$first_seen_ts" \
        "$last_seen_ts" \
        "$last_nonempty_ts" \
        "$incident_rca_version" \
        "$(sanitize_state_field "$incident_fingerprint")" \
        "$evidence_signal_keys" \
        "$existing_linear_ticket_id" \
        "$existing_slack_thread_ts" \
        "$affected_workloads" \
        "$category_drift_log" \
        "$existing_slack_post_status" \
        "$slack_post_attempts" \
        "$existing_linear_post_status" \
        "$linear_post_attempts" \
        "$existing_linear_reservation" \
        "$bs_alias_value" \
        "$last_primary_ts" \
        "$non_primary_streak"
    )"

    if state_write_row "$incident_id" "$incident_state_row" "$ACTIVE_INCIDENTS_FILE" >/dev/null 2>&1; then
      incident_state_status="updated"
    else
      incident_state_status="write_error"
    fi
  fi

  if [[ -n "$incident_id" ]]; then
    if mkdir -p "$INCIDENT_STATE_DIR" 2>/dev/null && [[ -d "$INCIDENT_STATE_DIR" ]]; then
      printf '%s\n' "$incident_id" >"$INCIDENT_LAST_ACTIVE_FILE" 2>/dev/null || true
    fi
  fi
else
  if [[ -f "$INCIDENT_LAST_ACTIVE_FILE" ]]; then
    resolved_incident_id="$(head -n1 "$INCIDENT_LAST_ACTIVE_FILE" 2>/dev/null || true)"
    resolved_incident_id="$(sanitize_state_field "$resolved_incident_id")"
  fi
  if [[ -n "$resolved_incident_id" ]]; then
    resolved_namespace=""
    resolved_workloads=""
    resolved_primary_service="unknown"
    if [[ "$HAS_LIB_STATE_FILE" -eq 1 ]] && declare -F state_read_incident >/dev/null 2>&1; then
      resolved_row="$(state_read_incident "$resolved_incident_id" "$ACTIVE_INCIDENTS_FILE" 2>/dev/null || true)"
      resolved_ticket_id="$(sanitize_state_field "$(tsv_field "$resolved_row" 10)")"
      resolved_thread_ts="$(sanitize_state_field "$(tsv_field "$resolved_row" 11)")"
      resolved_namespace="$(sanitize_state_field "$(tsv_field "$resolved_row" 2)")"
      resolved_workloads="$(sanitize_state_field "$(tsv_field "$resolved_row" 12)")"
      resolved_primary_service="$(printf '%s\n' "${resolved_workloads:-}" | awk -F'|' 'NF > 0 && $1 != "" { print $1; exit }')"
      if [[ -z "$resolved_primary_service" ]]; then
        resolved_primary_service="unknown"
      fi
      if declare -F state_archive_row >/dev/null 2>&1; then
        state_archive_row "$resolved_incident_id" "resolved_heartbeat" "$ACTIVE_INCIDENTS_FILE" "$RESOLVED_INCIDENTS_FILE" >/dev/null 2>&1 || true
      fi
    fi
    if [[ "$HAS_LIB_THREAD_ARCHIVAL" -eq 1 ]] && declare -F archive_thread >/dev/null 2>&1; then
      thread_archival_status="$(archive_thread "$resolved_thread_ts" "$resolved_incident_id" "$resolved_ticket_id" "final" 2>/dev/null | tail -n1 || true)"
      if [[ -z "$thread_archival_status" ]]; then
        thread_archival_status="archive_attempted"
      fi
    fi
    if [[ "${INCIDENT_LEARNING_ENABLED:-0}" == "1" && "$HAS_LIB_INCIDENT_MEMORY" -eq 1 ]] \
      && declare -F extract_incident_card >/dev/null 2>&1 \
      && declare -F memory_write_card >/dev/null 2>&1; then
      resolved_rca_json="$(rca_cache_get_field "$resolved_incident_id" '.rca_result_json // empty' "")"
      if [[ -n "$resolved_rca_json" && "$resolved_rca_json" != "null" ]]; then
        has_real_hypothesis="$(
          printf '%s\n' "$resolved_rca_json" \
            | jq -r '(.hypotheses // []) | map(select((.hypothesis_id // "") != "" and .hypothesis_id != "unknown:insufficient_evidence")) | length > 0' 2>/dev/null \
            || echo "false"
        )"
        if [[ "$has_real_hypothesis" == "true" ]]; then
          card_payload="$(CLUSTER="${K8S_CONTEXT:-unknown}" \
            NAMESPACE="${resolved_namespace:-unknown}" \
            SERVICE="${resolved_primary_service:-unknown}" \
            TRIAGE_INCIDENT_ID="$resolved_incident_id" \
            extract_incident_card "$resolved_rca_json" 2>/dev/null || true)"
          if [[ -n "$card_payload" ]]; then
            memory_write_card "$card_payload" >/dev/null 2>&1 || true
          fi
        fi
      fi
    fi
    rm -f "$INCIDENT_LAST_ACTIVE_FILE" 2>/dev/null || true
  fi
fi

top_hypothesis_score=""
top_hypothesis_confidence=""
top_hypothesis_title=""
top_hypothesis_evidence=""
if [[ "${#HYPOTHESES[@]}" -gt 0 ]]; then
  top_hypothesis_line="$(printf '%s\n' "${HYPOTHESES[@]}" | sort -t "$HYP_SEP" -k1,1nr | head -n1 || true)"
  IFS="$HYP_SEP" read -r top_hypothesis_score top_hypothesis_confidence top_hypothesis_title top_hypothesis_evidence _top_check _top_rollback <<<"$top_hypothesis_line"
fi
if ! [[ "${top_hypothesis_score:-}" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  top_hypothesis_score="40"
fi
if [[ -z "$top_hypothesis_title" ]]; then
  top_hypothesis_title="No ranked hypothesis available"
fi
if [[ -z "$top_hypothesis_evidence" ]]; then
  top_hypothesis_evidence="[NEEDS REVIEW]"
fi

rca_mode_requested="$(resolve_rca_mode)"
rca_mode_effective="$rca_mode_requested"
if [[ "$rca_mode_effective" == "dual" && "$HAS_LIB_RCA_SAFETY" -eq 1 ]] && declare -F rca_safety_effective_mode >/dev/null 2>&1; then
  rca_mode_effective="$(rca_safety_effective_mode "$rca_mode_effective" "$severity_level" "$(date +%s 2>/dev/null || echo 0)" 2>/dev/null || echo "$rca_mode_effective")"
  if [[ "$rca_mode_effective" == "dual_probe" ]]; then
    rca_mode_effective="dual"
  fi
fi

STEP_STATUS_11="skipped"
STEP_LATENCY_11=0
rca_result_source="ranked_hypotheses"
rca_result_status="fallback"
rca_review_rounds=0
rca_agreement_score="0"
rca_confidence="$top_hypothesis_score"
rca_summary="$(sanitize_signal_line "$top_hypothesis_title")"
rca_root_cause="$(sanitize_signal_line "$top_hypothesis_evidence")"
rca_degradation_note="Using ranked_hypotheses fallback"
sink_quarantine_status="none"
rca_result_json="$(
  jq -nc \
    --arg mode "heuristic" \
    --arg summary "$rca_summary" \
    --arg root_cause "$rca_root_cause" \
    --arg note "$rca_degradation_note" \
    --arg confidence "$rca_confidence" \
    '{
      mode: $mode,
      summary: $summary,
      root_cause: $root_cause,
      degradation_note: $note,
      hypotheses: [
        {
          canonical_category: "unknown",
          hypothesis_id: "unknown:insufficient_evidence",
          confidence: ($confidence | tonumber),
          description: $root_cause,
          evidence_keys: []
        }
      ]
    }'
)"

rca_skip=0
if [[ "$incident" -eq 1 && "$HAS_LIB_RCA_LLM" -eq 1 ]] && declare -F run_step_11 >/dev/null 2>&1; then
  step11_start_ms="$(now_ms)"
  evidence_raw=""
  for step_n in 00 01 02 03 04 05 06 07 08 09 10; do
    output_var="STEP_OUTPUT_${step_n}"
    status_var="STEP_STATUS_${step_n}"
    raw_output="${!output_var:-}"
    raw_status="${!status_var:-skipped}"
    if [[ -z "$raw_output" || "$raw_status" != "ok" ]]; then
      continue
    fi
    if declare -F _rca_prompt_scrub >/dev/null 2>&1; then
      raw_output="$(_rca_prompt_scrub "$raw_output")"
    fi
    if declare -F _strip_instruction_tokens >/dev/null 2>&1; then
      raw_output="$(_strip_instruction_tokens "$raw_output")"
    fi
    if declare -F truncate_step_output >/dev/null 2>&1; then
      raw_output="$(truncate_step_output "$raw_output" 4096)"
    fi
    evidence_raw="${evidence_raw}--- Step ${step_n} output ---"$'\n'"${raw_output}"$'\n\n'
  done

  evidence_bundle="$(
    {
      printf 'incident_id\t%s\n' "${incident_id:-unknown}"
      printf 'incident_fingerprint\t%s\n' "$incident_fingerprint"
      printf 'severity_level\t%s\n' "$severity_level"
      printf 'severity_reason\t%s\n' "$severity_reason"
      printf 'namespace_scope\t%s\n' "$SCOPE_NAMESPACES"
      printf 'signal\tpod_issues\t%s\n' "$pod_issue_count"
      printf 'signal\tdeploy_gaps\t%s\n' "$deploy_gap_count"
      printf 'signal\tcritical_alerts\t%s\n' "$critical_alert_count"
      printf 'signal\tlog_signals\t%s\n' "$log_signal_count"
      printf 'signal\tprom_critical\t%s\n' "$prom_trend_critical_count"
      printf 'signal\targocd_critical\t%s\n' "$argocd_critical_count"
      printf 'signal\tcert_critical\t%s\n' "$cert_health_critical_count"
      printf 'signal\taws_critical\t%s\n' "$aws_signal_critical_count"
      if [[ -n "${changes_in_window_summary:-}" ]]; then
        printf 'changes_in_window_summary\n%s\n' "$changes_in_window_summary"
      fi
      if [[ -n "${config_drift_output:-}" ]]; then
        printf 'config_drift\n%s\n' "$config_drift_output"
      fi
      if [[ -n "${config_lineage_output:-}" ]]; then
        printf 'config_lineage\n%s\n' "$config_lineage_output"
      fi
      if [[ -n "$linear_memory_output" ]]; then
        printf 'linear_memory\n%s\n' "$linear_memory_output"
      fi
      printf 'raw_step_outputs\n'
      if [[ -n "$evidence_raw" ]]; then
        printf '%s\n' "$evidence_raw"
      else
        printf 'none\n'
      fi
    } | awk 'NF > 0 { print }'
  )"

  llm_result_json=""
  cache_fingerprint="$(rca_cache_get_field "${incident_id:-}" '.evidence_fingerprint // empty' "")"
  cache_rca_ts="$(rca_cache_get_field "${incident_id:-}" '.last_rca_ts // 0' "0")"
  cache_rca_json="$(rca_cache_get_field "${incident_id:-}" '.rca_result_json // empty' "")"
  if ! [[ "$cache_rca_ts" =~ ^[0-9]+$ ]]; then
    cache_rca_ts=0
  fi
  now_epoch="$(date +%s 2>/dev/null || echo 0)"
  interval_elapsed=1
  if [[ "$now_epoch" =~ ^[0-9]+$ && "$cache_rca_ts" -gt 0 ]]; then
    if (( now_epoch - cache_rca_ts < RCA_MIN_RERUN_INTERVAL_S )); then
      interval_elapsed=0
    fi
  fi
  if [[ -n "$cache_fingerprint" && "$cache_fingerprint" == "$incident_fingerprint" && "$interval_elapsed" -eq 0 && -n "$cache_rca_json" && "$cache_rca_json" != "null" ]]; then
    rca_skip=1
    llm_result_json="$(printf '%s\n' "$cache_rca_json" | jq -c '.' 2>/dev/null || true)"
    log "RCA skip: fingerprint unchanged and interval not elapsed (${RCA_MIN_RERUN_INTERVAL_S}s)"
  fi

  if [[ "$rca_skip" -eq 0 ]]; then
    if [[ "$rca_mode_effective" == "dual" && "${RCA_CHAIN_ENABLED:-0}" != "1" ]]; then
      rca_dual_a="$(run_step_11 "$evidence_bundle" "single" "incident" "$linear_memory_output" "" "codex" 2>/dev/null || true)"
      rca_dual_b="$(run_step_11 "$evidence_bundle" "single" "incident" "$linear_memory_output" "" "claude" 2>/dev/null || true)"
      llm_result_json="$rca_dual_a"
      if [[ -n "$rca_dual_a" && -n "$rca_dual_b" && "$HAS_LIB_RCA_CROSSREVIEW" -eq 1 ]] && declare -F run_cross_review >/dev/null 2>&1; then
        cross_a="$rca_dual_a"
        cross_b="$rca_dual_b"
        cross_final=""
        for cross_round in 0 1 2; do
          cross_output="$(run_cross_review "$cross_round" "$cross_a" "$cross_b" "$evidence_bundle" 2>/dev/null || true)"
          [[ -z "$cross_output" ]] && continue
          if printf '%s\n' "$cross_output" | jq -e '.converged == false and .next_a != null and .next_b != null' >/dev/null 2>&1; then
            cross_a="$(printf '%s\n' "$cross_output" | jq -c '.next_a // {}' 2>/dev/null || printf '%s' "$cross_a")"
            cross_b="$(printf '%s\n' "$cross_output" | jq -c '.next_b // {}' 2>/dev/null || printf '%s' "$cross_b")"
            rca_review_rounds=$((cross_round + 1))
            continue
          fi
          cross_final="$cross_output"
          break
        done
        if [[ -z "$cross_final" ]]; then
          cross_final="$cross_a"
        fi
        if printf '%s\n' "$cross_final" | jq -e '.next_a != null and .next_b != null' >/dev/null 2>&1; then
          cross_final="$(printf '%s\n' "$cross_final" | jq -c '.next_a // {}' 2>/dev/null || printf '%s' "$cross_a")"
        fi
        llm_result_json="$cross_final"
        if [[ "$HAS_LIB_RCA_SAFETY" -eq 1 ]] && declare -F rca_safety_record_outcome >/dev/null 2>&1; then
          rca_convergence_outcome="not_converged"
          if printf '%s\n' "$llm_result_json" | jq -e '(.agreement_score // 0) > 0' >/dev/null 2>&1; then
            rca_convergence_outcome="converged"
          fi
          rca_safety_record_outcome "$(date +%s 2>/dev/null || echo 0)" "$rca_convergence_outcome" >/dev/null 2>&1 || true
        fi
      fi
    else
      llm_result_json="$(run_step_11 "$evidence_bundle" "$rca_mode_effective" "incident" "$linear_memory_output" "" 2>/dev/null || true)"
    fi
  fi

  step11_end_ms="$(now_ms)"
  STEP_LATENCY_11=$((step11_end_ms - step11_start_ms))
  if [[ "$STEP_LATENCY_11" -lt 0 || "$rca_skip" -eq 1 ]]; then
    STEP_LATENCY_11=0
  fi

  if [[ -n "$llm_result_json" ]] && printf '%s\n' "$llm_result_json" | jq -e . >/dev/null 2>&1; then
    if [[ "$rca_skip" -eq 1 ]]; then
      STEP_STATUS_11="skipped"
      rca_result_source="cache"
      rca_result_status="cached"
    else
      STEP_STATUS_11="ok"
      rca_result_source="llm"
      rca_result_status="ok"
    fi
    rca_result_json="$(printf '%s\n' "$llm_result_json" | jq -c '.')"
    rca_confidence="$(printf '%s\n' "$rca_result_json" | jq -r '.merged_confidence // .hypotheses[0].confidence // .confidence // 40')"
    if ! [[ "$rca_confidence" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
      rca_confidence="$top_hypothesis_score"
    fi
    rca_summary="$(sanitize_signal_line "$(printf '%s\n' "$rca_result_json" | jq -r '.summary // .brief_description // .hypotheses[0].description // empty')")"
    rca_root_cause="$(sanitize_signal_line "$(printf '%s\n' "$rca_result_json" | jq -r '.root_cause // .hypotheses[0].description // empty')")"
    rca_degradation_note="$(sanitize_signal_line "$(printf '%s\n' "$rca_result_json" | jq -r '.degradation_note // empty')")"
    rca_agreement_score="$(printf '%s\n' "$rca_result_json" | jq -r '.agreement_score // 0')"
    if ! [[ "$rca_agreement_score" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
      rca_agreement_score="0"
    fi
    parsed_review_rounds="$(printf '%s\n' "$rca_result_json" | jq -r '.review_rounds // empty' 2>/dev/null || true)"
    if [[ "$parsed_review_rounds" =~ ^[0-9]+$ ]]; then
      rca_review_rounds="$parsed_review_rounds"
    fi
    if [[ "$rca_skip" -eq 0 && "$rca_mode_effective" == "dual" && "${RCA_CHAIN_ENABLED:-0}" == "1" ]] \
      && [[ "$HAS_LIB_RCA_SAFETY" -eq 1 ]] \
      && declare -F rca_safety_record_outcome >/dev/null 2>&1; then
      rca_convergence_outcome="not_converged"
      if printf '%s\n' "$rca_result_json" | jq -e '(.agreement_score // 0) > 0' >/dev/null 2>&1; then
        rca_convergence_outcome="converged"
      fi
      rca_safety_record_outcome "$(date +%s 2>/dev/null || echo 0)" "$rca_convergence_outcome" >/dev/null 2>&1 || true
    fi
  else
    STEP_STATUS_11="error"
    rca_result_status="fallback"
    rca_result_source="ranked_hypotheses"
    rca_degradation_note="LLM unavailable or invalid output; ranked_hypotheses fallback"
    rca_result_json="$(printf '%s\n' "$rca_result_json" | jq -c --arg note "$rca_degradation_note" '.degradation_note = $note')"
  fi

  evidence_gap_status="disabled"
  evidence_gap_json=""
  recollect_events=""
  recollect_category="$(printf '%s\n' "$rca_result_json" | jq -r '.canonical_category // .hypotheses[0].canonical_category // empty' 2>/dev/null || true)"
  if [[ -z "$recollect_category" || "$recollect_category" == "null" || "$recollect_category" == "unknown" ]]; then
    recollect_category="${step11_dedup_category:-unknown}"
  fi
  collect_phase2_rewards_provider_context_if_available
  if [[ "$recollect_category" != "unknown" ]]; then
    run_phase3_recollection_loop "$recollect_category" "$evidence_bundle"
  fi
fi

final_missing_critical_count="$(printf '%s\n' "${evidence_gap_json:-{}}" | jq -r '(.missing_critical // []) | length' 2>/dev/null || printf '0')"
if [[ "$final_missing_critical_count" =~ ^[0-9]+$ ]] && [[ "$final_missing_critical_count" -gt 0 ]]; then
  if awk -v c="$rca_confidence" 'BEGIN { exit !(c > 60) }'; then
    apply_rca_confidence_cap "60" "Missing critical evidence after recollection; confidence capped at 60"
  fi
fi

evidence_applicable_steps=0
evidence_completed_steps=0
mark_evidence_step 01 1
mark_evidence_step 02 1
mark_evidence_step 05 1
linear_memory_applicable=0
[[ -n "$(resolve_helper_script "linear-memory-lookup.sh")" ]] && linear_memory_applicable=1
mark_evidence_step 00 "$linear_memory_applicable"
prometheus_applicable=0
[[ -n "$(resolve_helper_script "prometheus-trends.sh")" && -n "${PROMETHEUS_URL:-}" ]] && prometheus_applicable=1
mark_evidence_step 03 "$prometheus_applicable"
argocd_applicable=0
[[ -n "$(resolve_helper_script "argocd-sync-status.sh")" && -n "${ARGOCD_BASE_URL:-}" ]] && argocd_applicable=1
mark_evidence_step 04 "$argocd_applicable"
cert_applicable=0
[[ -n "$(resolve_helper_script "cert-secret-health.sh")" ]] && cert_applicable=1
mark_evidence_step 06 "$cert_applicable"
aws_applicable=0
[[ -n "$(resolve_helper_script "aws-resource-signals.sh")" ]] && aws_applicable=1
mark_evidence_step 07 "$aws_applicable"
mark_evidence_step 08 "$INCLUDE_REPO_MAP"
mark_evidence_step 09 "$INCLUDE_IMAGE_REVISION"
mark_evidence_step 10 "$INCLUDE_CI_SIGNAL"

if [[ "$evidence_applicable_steps" -gt 0 ]]; then
  evidence_completeness_pct="$(awk -v c="$evidence_completed_steps" -v a="$evidence_applicable_steps" 'BEGIN { printf "%.1f", (c * 100.0) / a }')"
  evidence_completeness_ratio="$(awk -v c="$evidence_completed_steps" -v a="$evidence_applicable_steps" 'BEGIN { printf "%.3f", c / a }')"
else
  evidence_completeness_pct="0.0"
  evidence_completeness_ratio="0.000"
fi

if awk -v p="$evidence_completeness_pct" 'BEGIN { exit (p < 60 ? 0 : 1) }' && awk -v c="$rca_confidence" 'BEGIN { exit (c > 50 ? 0 : 1) }'; then
  apply_rca_confidence_cap "50" "Evidence completeness below 60%; confidence capped at 50"
fi

if [[ "$incident" -eq 1 && "$rca_skip" -eq 0 && -n "${incident_id:-}" && -n "${rca_result_json:-}" ]] && printf '%s\n' "$rca_result_json" | jq -e . >/dev/null 2>&1; then
  cache_write_epoch="${now_epoch:-$(date +%s 2>/dev/null || echo 0)}"
  if ! rca_cache_write_json "${incident_id:-}" "$incident_fingerprint" "$cache_write_epoch" "$rca_result_json" >/dev/null 2>&1; then
    rca_cache_write_error="incident_id=${incident_id:-unknown}"
    log "RCA cache write failed for ${incident_id:-unknown}"
  else
    rca_cache_write_error=""
  fi
fi

step_timeout_count=0
step_error_count=0
step_ok_count=0
step_skipped_count=0
for step_num in 00 01 02 03 04 05 06 07 08 09 10 11; do
  status_var="STEP_STATUS_${step_num}"
  step_status_value="${!status_var:-skipped}"
  case "$step_status_value" in
    timeout) step_timeout_count=$((step_timeout_count + 1)) ;;
    error) step_error_count=$((step_error_count + 1)) ;;
    ok) step_ok_count=$((step_ok_count + 1)) ;;
    *) step_skipped_count=$((step_skipped_count + 1)) ;;
  esac
done
total_step_count=$((step_timeout_count + step_error_count + step_ok_count + step_skipped_count))
if [[ "$total_step_count" -gt 0 ]]; then
  step_timeout_rate_pct="$(awk -v t="$step_timeout_count" -v n="$total_step_count" 'BEGIN { printf "%.1f", (t * 100.0) / n }')"
else
  step_timeout_rate_pct="0.0"
fi

meta_alert_rows=""
if [[ "$HAS_LIB_META_ALERTS" -eq 1 ]] && declare -F meta_alerts_evaluate >/dev/null 2>&1; then
  export META_STEP_TIMEOUT_RATE="$step_timeout_rate_pct"
  if awk -v p="$evidence_completeness_pct" 'BEGIN { exit (p < 60 ? 0 : 1) }'; then
    export META_CONSEC_LOW_COMPLETENESS=5
  else
    export META_CONSEC_LOW_COMPLETENESS=0
  fi
  if [[ -f "$META_ALERTS_METRICS_FILE" ]] && declare -F meta_alerts_from_file >/dev/null 2>&1; then
    meta_alert_rows="$(meta_alerts_from_file "$META_ALERTS_METRICS_FILE" 2>/dev/null || true)"
  else
    meta_alert_rows="$(meta_alerts_evaluate 2>/dev/null || true)"
  fi
fi

write_phase1_shadow_artifacts

if [[ "${step11_lease_acquired:-0}" -eq 1 ]]; then
  step11_payload="$(
    jq -nc \
      --arg snapshot_utc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg dedup_key "$step11_dedup_key" \
      --arg incident_id "${incident_id:-}" \
      --arg namespace "$step11_dedup_namespace" \
      --arg primary_category "$step11_dedup_category" \
      --arg severity_level "$severity_level" \
      --arg severity_reason "$severity_reason" \
      --arg should_alert "$should_alert" \
      --arg gate_reason "$gate_reason" \
      --arg incident_fingerprint "$incident_fingerprint" \
      --arg rca_mode "$rca_mode_effective" \
      --arg evidence_completeness_pct "$evidence_completeness_pct" \
      --arg incident_rca_version "$incident_rca_version" \
      --argjson hypothesis_count "${#HYPOTHESES[@]}" \
      '{
        snapshot_utc: $snapshot_utc,
        dedup_key: $dedup_key,
        incident_id: $incident_id,
        namespace: $namespace,
        primary_category: $primary_category,
        severity_level: $severity_level,
        severity_reason: $severity_reason,
        should_alert: $should_alert,
        gate_reason: $gate_reason,
        incident_fingerprint: $incident_fingerprint,
        rca_mode: $rca_mode,
        evidence_completeness_pct: $evidence_completeness_pct,
        rca_version: $incident_rca_version,
        hypothesis_count: $hypothesis_count
      }'
  )"
  spool_payload="$step11_payload"
  redact_failed_sink=""
  for sink_name in slack linear webhook; do
    if ! spool_payload="$(redact_payload_for_sink "$spool_payload" "$sink_name" 2>/dev/null)"; then
      redact_failed_sink="$sink_name"
      break
    fi
  done
  if [[ -n "$redact_failed_sink" ]]; then
    sink_quarantine_status="quarantined:${redact_failed_sink}"
    log "WARN: sink payload quarantined for ${redact_failed_sink}; suppressing outbound spool write"
    release_lease "$step11_dedup_key"
  elif write_spool_payload "$step11_dedup_key" "$spool_payload" >/dev/null 2>&1; then
    coalesce_spool_for_key "$step11_dedup_key" >/dev/null 2>&1 || true
    release_lease "$step11_dedup_key"
  else
    sink_quarantine_status="spool_write_failed"
    abandon_lease "$step11_dedup_key"
  fi
fi

section "meta"
printf 'snapshot_utc\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'context\t%s\n' "$K8S_CONTEXT"
printf 'namespace_scope\t%s\n' "${SCOPE_NAMESPACES:-all}"
printf 'incident_id\t%s\n' "${incident_id:-none}"
printf 'incident_state\t%s\n' "$incident_state_status"

section "step_status"
printf 'step\tstatus\tlatency_ms\n'
for step_num in 00 01 02 03 04 05 06 07 08 09 10 11; do
  status_var="STEP_STATUS_${step_num}"
  latency_var="STEP_LATENCY_${step_num}"
  printf '%s\t%s\t%s\n' "$step_num" "${!status_var:-skipped}" "${!latency_var:-0}"
done

section "health_status"
if [[ "$incident" -eq 1 ]]; then
  printf 'state\tincident\n'
else
printf 'state\tok\n'
fi
printf 'incident_signals\t%s\n' "$((pod_issue_count + deploy_gap_count + critical_alert_count + image_pull_count + create_config_count + log_signal_count + prom_trend_critical_count + argocd_critical_count + cert_health_critical_count + aws_signal_critical_count))"

section "incident_gate"
printf 'should_alert\t%s\n' "$should_alert"
printf 'gate_reason\t%s\n' "$gate_reason"
printf 'incident_id\t%s\n' "${incident_id:-none}"
printf 'rca_version\t%s\n' "$incident_rca_version"
printf 'incident_fingerprint\t%s\n' "$incident_fingerprint"
printf 'cooldown_seconds\t%s\n' "$ALERT_COOLDOWN_SECONDS"
printf 'alert_min_interval_seconds\t%s\n' "$ALERT_MIN_INTERVAL_SECONDS"
printf 'cooldown_remaining_seconds\t%s\n' "$cooldown_remaining_seconds"

section "incident_routing"
printf 'severity_level\t%s\n' "$severity_level"
printf 'severity_score\t%s\n' "$severity_score"
printf 'severity_reason\t%s\n' "$severity_reason"
printf 'recommended_target\t%s\n' "$recommended_target"
printf 'recommended_mode\t%s\n' "$recommended_mode"

section "impact_scope"
printf 'primary_namespaces\t%s\n' "$PRIMARY_NAMESPACES"
printf 'primary_impact_signals\t%s\n' "$primary_impact_signals"
printf 'primary_pod_issues\t%s\n' "$primary_pod_issue_count"
printf 'primary_container_failures\t%s\n' "$primary_container_failure_count"
printf 'primary_log_signals\t%s\n' "$primary_log_signal_count"
printf 'primary_deploy_gaps\t%s\n' "$primary_deploy_gap_count"
printf 'primary_critical_alerts\t%s\n' "$primary_critical_alert_count"
printf 'supporting_pod_issues\t%s\n' "$supporting_pod_issue_count"
printf 'supporting_container_failures\t%s\n' "$supporting_container_failure_count"
printf 'supporting_log_signals\t%s\n' "$supporting_log_signal_count"
printf 'supporting_deploy_gaps\t%s\n' "$supporting_deploy_gap_count"
printf 'supporting_critical_alerts\t%s\n' "$supporting_critical_alert_count"

section "signal_summary"
printf 'pod_issues\t%s\n' "$pod_issue_count"
printf 'container_failure_signals\t%s\n' "$container_failure_count"
printf 'log_error_signals\t%s\n' "$log_signal_count"
printf 'log_authz_signals\t%s\n' "$log_authz_count"
printf 'log_network_signals\t%s\n' "$log_network_count"
printf 'log_tls_signals\t%s\n' "$log_tls_count"
printf 'log_crash_signals\t%s\n' "$log_crash_count"
printf 'log_oom_signals\t%s\n' "$log_oom_count"
printf 'deploy_readiness_gaps\t%s\n' "$deploy_gap_count"
printf 'warning_events\t%s\n' "$event_count"
printf 'firing_alerts_filtered\t%s\n' "$alert_count"
printf 'critical_alerts_filtered\t%s\n' "$critical_alert_count"
printf 'prometheus_trend_critical\t%s\n' "$prom_trend_critical_count"
printf 'prometheus_trend_warning\t%s\n' "$prom_trend_warning_count"
printf 'argocd_sync_critical\t%s\n' "$argocd_critical_count"
printf 'argocd_sync_warning\t%s\n' "$argocd_warning_count"
printf 'cert_health_critical\t%s\n' "$cert_health_critical_count"
printf 'cert_health_warning\t%s\n' "$cert_health_warning_count"
printf 'aws_signal_critical\t%s\n' "$aws_signal_critical_count"
printf 'aws_signal_warning\t%s\n' "$aws_signal_warning_count"
printf 'db_schema_check\t%s\n' "$db_schema_check"
printf 'db_data_check\t%s\n' "$db_data_check"
printf 'pg_internal_check\t%s\n' "$pg_internal_check"
printf 'replica_lag_signal\t%s\n' "$replica_lag"
printf 'pg_activity_signal\t%s\n' "$pg_activity"
printf 'pg_statements_signal\t%s\n' "$pg_statements"
printf 'pg_conflicts_signal\t%s\n' "$pg_conflicts"
printf 'db_topology_signal\t%s\n' "$db_topology"
printf 'rewards_provider_mode\t%s\n' "${rewards_provider_mode:-0}"
printf 'db_row_provenance\t%s\n' "${db_row_provenance:-0}"
printf 'provider_api_check\t%s\n' "${provider_api_check:-0}"
printf 'provider_side_mismatch\t%s\n' "${provider_side_mismatch:-0}"
printf 'artifact_check\t%s\n' "${artifact_check:-0}"
printf 'code_path_check\t%s\n' "${code_path_check:-0}"
printf 'code_path_reconciled\t%s\n' "${code_path_reconciled:-0}"
printf 'disproved_theory_recorded\t%s\n' "${disproved_theory_recorded:-0}"
printf 'disproved_theory_expected\t%s\n' "${disproved_theory_expected:-0}"
printf 'same_token_both_sides_expected\t%s\n' "${same_token_both_sides_expected:-0}"
printf 'linear_memory_matches\t%s\n' "$linear_memory_rows_count"
printf 'resolved_image_revisions\t%s\n' "$revision_resolved_count"
printf 'suspect_prs\t%s\n' "$suspect_pr_count"
printf 'missing_secret_events\t%s\n' "$missing_secret_count"
printf 'missing_configmap_events\t%s\n' "$missing_configmap_count"
printf 'create_config_errors\t%s\n' "$create_config_count"
printf 'image_pull_errors\t%s\n' "$image_pull_count"
printf 'crashloop_or_oom\t%s\n' "$crashloop_count"
printf 'oom_killed\t%s\n' "$oom_killed_count"
printf 'nonzero_exit\t%s\n' "$nonzero_exit_count"
printf 'hpa_metrics_api_errors\t%s\n' "$hpa_metrics_count"
printf 'cnpg_unknown_cluster_events\t%s\n' "$finding_cluster_count"

section "linear_incident_memory"
printf 'status\t%s\n' "$linear_memory_status"
printf 'rows\t%s\n' "$linear_memory_rows_count"
printf 'note\t%s\n' "$linear_memory_note"
if [[ -n "$linear_memory_output" ]]; then
  printf '%s\n' "$linear_memory_output"
else
  echo "none"
fi

section "prometheus_trends"
printf 'step_status\t%s\n' "${STEP_STATUS_03:-skipped}"
printf 'critical\t%s\n' "$prom_trend_critical_count"
printf 'warning\t%s\n' "$prom_trend_warning_count"
if [[ -n "$prometheus_trends_output" ]]; then
  printf '%s\n' "$prometheus_trends_output"
else
  echo "none"
  printf 'note\t%s\n' "$prom_trend_note"
fi

section "argocd_sync"
printf 'step_status\t%s\n' "${STEP_STATUS_04:-skipped}"
printf 'critical\t%s\n' "$argocd_critical_count"
printf 'warning\t%s\n' "$argocd_warning_count"
if [[ -n "$argocd_sync_output" ]]; then
  printf '%s\n' "$argocd_sync_output"
else
  echo "none"
  printf 'note\t%s\n' "$argocd_note"
fi
if [[ -n "${argocd_drift_evidence_output:-}" ]]; then
  printf '%s\n' "$argocd_drift_evidence_output"
fi

if [[ -n "${config_drift_output:-}" ]]; then
section "config_drift"
printf 'count\t%s\n' "${config_drift_count:-0}"
printf '%s\n' "$config_drift_output"
fi

if [[ -n "${config_lineage_output:-}" ]]; then
section "config_lineage"
printf '%s\n' "$config_lineage_output"
fi

section "cert_secret_health"
printf 'step_status\t%s\n' "${STEP_STATUS_06:-skipped}"
printf 'critical\t%s\n' "$cert_health_critical_count"
printf 'warning\t%s\n' "$cert_health_warning_count"
if [[ -n "$cert_secret_health_output" ]]; then
  printf '%s\n' "$cert_secret_health_output"
else
  echo "none"
  printf 'note\t%s\n' "$cert_health_note"
fi

section "aws_resource_signals"
printf 'step_status\t%s\n' "${STEP_STATUS_07:-skipped}"
printf 'critical\t%s\n' "$aws_signal_critical_count"
printf 'warning\t%s\n' "$aws_signal_warning_count"
if [[ -n "$aws_resource_signals_output" ]]; then
  printf '%s\n' "$aws_resource_signals_output"
else
  echo "none"
  printf 'note\t%s\n' "$aws_signal_note"
fi

section "db_evidence"
printf 'status\t%s\n' "$db_evidence_status"
printf 'target\t%s\n' "$db_evidence_target"
printf 'note\t%s\n' "$db_evidence_note"
printf 'db_schema_check\t%s\n' "$db_schema_check"
printf 'db_data_check\t%s\n' "$db_data_check"
printf 'pg_internal_check\t%s\n' "$pg_internal_check"
printf 'replica_lag\t%s\n' "$replica_lag"
printf 'pg_activity\t%s\n' "$pg_activity"
printf 'pg_statements\t%s\n' "$pg_statements"
printf 'pg_conflicts\t%s\n' "$pg_conflicts"
printf 'db_topology\t%s\n' "$db_topology"
if [[ -n "$db_evidence_rows" ]]; then
  printf '%s\n' "$db_evidence_rows"
else
  echo "none"
fi

section "rewards_provider_context"
printf 'mode\t%s\n' "${rewards_provider_mode:-0}"
printf 'db_row_provenance\t%s\n' "${db_row_provenance:-0}"
printf 'provider_api_check\t%s\n' "${provider_api_check:-0}"
printf 'provider_side_mismatch\t%s\n' "${provider_side_mismatch:-0}"
printf 'artifact_check\t%s\n' "${artifact_check:-0}"
printf 'code_path_check\t%s\n' "${code_path_check:-0}"
printf 'code_path_reconciled\t%s\n' "${code_path_reconciled:-0}"
printf 'disproved_theory_recorded\t%s\n' "${disproved_theory_recorded:-0}"
printf 'disproved_theory_expected\t%s\n' "${disproved_theory_expected:-0}"
printf 'same_token_both_sides_expected\t%s\n' "${same_token_both_sides_expected:-0}"
if [[ -n "${rewards_provider_context_note:-}" ]]; then
  printf 'note\t%s\n' "$rewards_provider_context_note"
fi
if [[ -n "${db_row_provenance_evidence_output:-}" ]]; then
  printf 'db_row_provenance_evidence_output\t%s\n' "$db_row_provenance_evidence_output"
fi
if [[ -n "${provider_api_evidence_output:-}" ]]; then
  printf 'provider_api_evidence_output\t%s\n' "$provider_api_evidence_output"
fi
if [[ -n "${provider_side_mismatch_evidence_output:-}" ]]; then
  printf 'provider_side_mismatch_evidence_output\t%s\n' "$provider_side_mismatch_evidence_output"
fi
if [[ -n "${artifact_evidence_output:-}" ]]; then
  printf 'artifact_evidence_output\t%s\n' "$artifact_evidence_output"
fi
if [[ -n "${code_path_evidence_output:-}" ]]; then
  printf 'code_path_evidence_output\t%s\n' "$code_path_evidence_output"
fi
if [[ -n "${code_path_reconciled_evidence_output:-}" ]]; then
  printf 'code_path_reconciled_evidence_output\t%s\n' "$code_path_reconciled_evidence_output"
fi
if [[ -n "${disproved_theory_evidence_output:-}" ]]; then
  printf 'disproved_theory_evidence_output\t%s\n' "$disproved_theory_evidence_output"
fi

section "indexer_freshness_context"
printf 'mode\t%s\n' "${indexer_freshness_mode:-0}"
printf 'note\t%s\n' "${indexer_freshness_note:-disabled}"
printf 'workloads\t%s\n' "${indexer_workloads:-}"
printf 'recent_match_count\t%s\n' "${indexer_recent_match_count:-0}"
printf 'canonical_category_hint\t%s\n' "${indexer_canonical_category_hint:-unknown}"
printf 'db_vs_live_head_gap\t%s\n' "${indexer_db_vs_live_head_gap:-0}"
printf 'processed_vs_head_rate_gap\t%s\n' "${indexer_processed_vs_head_rate_gap:-0}"
printf 'metric_blind_spot\t%s\n' "${indexer_metric_blind_spot:-0}"
printf 'resources_missing\t%s\n' "${indexer_resources_missing:-0}"
printf 'queue_backlog\t%s\n' "${indexer_queue_backlog:-0}"
printf 'rpc_mismatch\t%s\n' "${indexer_rpc_mismatch:-0}"
printf 'recurring_incident\t%s\n' "${indexer_recurring_incident:-0}"

section "rca_result"
printf 'status\t%s\n' "$rca_result_status"
printf 'source\t%s\n' "$rca_result_source"
printf 'mode_requested\t%s\n' "$rca_mode_requested"
printf 'mode_effective\t%s\n' "$rca_mode_effective"
printf 'confidence\t%s\n' "$rca_confidence"
printf 'agreement_score\t%s\n' "$rca_agreement_score"
printf 'review_rounds\t%s\n' "$rca_review_rounds"
printf 'summary\t%s\n' "$rca_summary"
printf 'root_cause\t%s\n' "$rca_root_cause"
printf 'degradation_note\t%s\n' "${rca_degradation_note:-none}"
printf 'cache_write_error\t%s\n' "${rca_cache_write_error:-none}"
printf 'evidence_gap_status\t%s\n' "${evidence_gap_status:-disabled}"
if [[ -n "${evidence_gap_json:-}" ]]; then
  printf 'evidence_gap_json\t%s\n' "$evidence_gap_json"
fi
if [[ -n "${recollect_events:-}" ]]; then
  printf 'recollect_events\n%s\n' "$recollect_events"
fi
if [[ -n "$rca_result_json" ]]; then
  printf '%s\n' "$rca_result_json"
else
  echo "none"
fi

section "triage_metrics"
printf 'incident_id\t%s\n' "${incident_id:-none}"
printf 'mode\t%s\n' "$rca_mode_effective"
printf 'evidence_completed_steps\t%s\n' "$evidence_completed_steps"
printf 'evidence_applicable_steps\t%s\n' "$evidence_applicable_steps"
printf 'evidence_completeness_pct\t%s\n' "$evidence_completeness_pct"
printf 'evidence_completeness_ratio\t%s\n' "$evidence_completeness_ratio"
printf 'step_ok\t%s\n' "$step_ok_count"
printf 'step_timeouts\t%s\n' "$step_timeout_count"
printf 'step_errors\t%s\n' "$step_error_count"
printf 'step_skips\t%s\n' "$step_skipped_count"
printf 'step_timeout_rate_pct\t%s\n' "$step_timeout_rate_pct"
printf 'linear_memory_status\t%s\n' "$linear_memory_status"
printf 'incident_state_status\t%s\n' "$incident_state_status"
printf 'thread_archival_status\t%s\n' "$thread_archival_status"
printf 'rca_skip\t%s\n' "$rca_skip"
printf 'sink_quarantine_status\t%s\n' "$sink_quarantine_status"

section "meta_alerts"
if [[ "$HAS_LIB_META_ALERTS" -eq 1 ]]; then
  if [[ -n "$meta_alert_rows" ]]; then
    printf '%s\n' "$meta_alert_rows"
  else
    echo "none"
  fi
else
  echo "disabled"
fi

section "top_pod_issues"
printf 'namespace\tpod\tphase\trestarts\treasons\n'
if [[ -n "$pod_rows" ]]; then
  printf '%s\n' "$pod_rows" | sed -n "1,${POD_LIMIT}p"
else
  echo "none"
fi

section "top_container_failures"
printf 'namespace\tpod\tcontainer\tkind\trestarts\tstate\treason\texit_code\tmessage\n'
if [[ -n "$container_state_rows" ]]; then
  printf '%s\n' "$container_state_rows" | sed -n "1,${CONTAINER_LIMIT}p"
else
  echo "none"
fi

section "top_log_signals"
printf 'namespace\tpod\tcontainer\tsignal\tline\n'
if [[ -n "$log_signal_rows" ]]; then
  printf '%s\n' "$log_signal_rows" | sed -n "1,${CONTAINER_LIMIT}p"
else
  echo "none"
fi

section "top_deploy_gaps"
printf 'namespace\tdeployment\tdesired\tavailable\tupdated\tunavailable\n'
if [[ -n "$deploy_rows" ]]; then
  printf '%s\n' "$deploy_rows" | sed -n "1,${DEPLOY_LIMIT}p"
else
  echo "none"
fi

section "top_warning_events"
printf 'namespace\tobject\treason\tlast_seen\tmessage\n'
if [[ -n "$event_rows" ]]; then
  printf '%s\n' "$event_rows" | tail -n "$EVENT_LIMIT"
else
  echo "none"
fi

section "top_firing_alerts_filtered"
printf 'severity\talertname\tnamespace\tpod\tjob\tactive_at\n'
if [[ -n "$alert_rows" ]]; then
  printf '%s\n' "$alert_rows" | sed -n "1,${ALERT_LIMIT}p"
else
  echo "none"
fi

section "impacted_repos"
printf 'namespace\tpod\timage\tgithub_repo\tlocal_repo_path\tmapping_source\n'
if [[ -n "$repo_map_rows" ]]; then
  printf '%s\n' "$repo_map_rows" | sed -n "1,${RCA_ENRICH_LIMIT}p"
else
  echo "none"
  if [[ -n "$repo_map_note" ]]; then
    printf 'note\t%s\n' "$repo_map_note"
  fi
fi

section "image_revision_signal"
printf 'namespace\tpod\timage\tgithub_repo\timage_tag\tcommit_hint\tcommit_resolved\tcommit_time\tcommit_subject\tpr_number\tpr_title\tpr_state\tpr_url\n'
if [[ -n "$revision_rows" ]]; then
  printf '%s\n' "$revision_rows" | sed -n "1,${RCA_ENRICH_LIMIT}p"
else
  echo "none"
  if [[ -n "$revision_note" ]]; then
    printf 'note\t%s\n' "$revision_note"
  fi
fi

section "suspect_prs"
printf 'repo\tpr_number\tpr_title\tpr_state\tpr_url\tnamespace\tpod\n'
if [[ -n "$suspect_pr_rows" ]]; then
  printf '%s\n' "$suspect_pr_rows" | sed -n "1,${RCA_ENRICH_LIMIT}p"
else
  echo "none"
fi

section "repo_ci_signal"
printf 'repo\tworkflow\trun_number\tstatus\tconclusion\tbranch\tsha\tupdated_at\turl\n'
if [[ -n "$ci_rows" ]]; then
  printf '%s\n' "$ci_rows"
else
  echo "none"
  if [[ -n "$ci_note" ]]; then
    printf 'note\t%s\n' "$ci_note"
  fi
fi

section "pr_candidates"
printf 'repo\treason\tlikely_files\n'
if [[ -n "$pr_candidate_rows" ]]; then
  printf '%s' "$pr_candidate_rows" \
    | sort -u \
    | sed -n "1,${RCA_ENRICH_LIMIT}p"
else
  echo "none"
fi

section "ranked_hypotheses"
if [[ "${#HYPOTHESES[@]}" -eq 0 ]]; then
  echo "none"
else
  idx=1
  while IFS="$HYP_SEP" read -r _score confidence title evidence check rollback; do
    printf '%s\t%s\t%s\n' "$idx" "$confidence" "$title"
    printf 'evidence\t%s\n' "$evidence"
    printf 'check\t%s\n' "$check"
    printf 'rollback\t%s\n' "$rollback"
    idx=$((idx + 1))
  done < <(printf '%s\n' "${HYPOTHESES[@]}" | sort -t "$HYP_SEP" -k1,1nr)
fi

section "next_checks"
echo "1) kubectl --context <context> -n <ns> describe pod <pod>"
echo "2) kubectl --context <context> -n <ns> get events --sort-by=.lastTimestamp | tail -n 50"
echo "3) kubectl --context <context> -n <ns> get deploy <name> -o yaml | rg -n 'image|secret|configMap|envFrom'"
echo "4) /home/node/.openclaw/skills/morpho-sre/scripts/image-repo-map.sh --image <workload-or-image>"
echo "5) /home/node/.openclaw/skills/morpho-sre/scripts/repo-clone.sh --image <workload-or-image>"
echo "6) /home/node/.openclaw/skills/morpho-sre/scripts/github-ci-status.sh --image <workload-or-image> --limit 5"
echo "7) kubectl --context <context> -n <ns> logs <pod> -c <container> --tail=200 --previous"
echo "8) gh pr view <pr-number> -R <owner/repo> --json number,title,state,mergedAt,author,url"
