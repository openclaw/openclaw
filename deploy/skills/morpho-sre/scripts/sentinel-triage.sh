#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

for cmd in awk cksum date jq kubectl sed sort tr; do
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
KUBECTL_TIMEOUT="${KUBECTL_TIMEOUT:-20s}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://prometheus-stack-kube-prom-prometheus.monitoring.svc.cluster.local:9090}"
PROMETHEUS_TIMEOUT_SECONDS="${PROMETHEUS_TIMEOUT_SECONDS:-8}"
IGNORE_ALERTNAMES="${IGNORE_ALERTNAMES:-Watchdog,CPUThrottlingHigh,KubeControllerManagerDown,KubeSchedulerDown,KubeJobFailed,KubeDeploymentReplicasMismatch,KubeDeploymentRolloutStuck,KubeHpaMaxedOut}"
RCA_SCRIPT_DIR="${RCA_SCRIPT_DIR:-/home/node/.openclaw/skills/morpho-sre/scripts}"
INCLUDE_REPO_MAP="${INCLUDE_REPO_MAP:-1}"
INCLUDE_CI_SIGNAL="${INCLUDE_CI_SIGNAL:-1}"
INCLUDE_LOG_SNIPPETS="${INCLUDE_LOG_SNIPPETS:-1}"
INCLUDE_IMAGE_REVISION="${INCLUDE_IMAGE_REVISION:-1}"
RCA_ENRICH_LIMIT="${RCA_ENRICH_LIMIT:-8}"
CI_REPO_LIMIT="${CI_REPO_LIMIT:-3}"
CI_RUN_LIMIT="${CI_RUN_LIMIT:-3}"
ALERT_COOLDOWN_SECONDS="${ALERT_COOLDOWN_SECONDS:-1800}"
INCIDENT_STATE_DIR="${INCIDENT_STATE_DIR:-/home/node/.openclaw/state/sentinel}"
INCIDENT_STATE_FILE="${INCIDENT_STATE_FILE:-${INCIDENT_STATE_DIR}/incident-gate.tsv}"
SEVERITY_CRITICAL_SCORE="${SEVERITY_CRITICAL_SCORE:-85}"
SEVERITY_HIGH_SCORE="${SEVERITY_HIGH_SCORE:-60}"
SEVERITY_MEDIUM_SCORE="${SEVERITY_MEDIUM_SCORE:-30}"
PRIMARY_NAMESPACES="${PRIMARY_NAMESPACES:-morpho-dev}"
ROUTE_TARGET_CRITICAL="${ROUTE_TARGET_CRITICAL:-user:U07KE3NALTX}"
ROUTE_TARGET_HIGH="${ROUTE_TARGET_HIGH:-user:U07KE3NALTX}"
ROUTE_TARGET_MEDIUM="${ROUTE_TARGET_MEDIUM:-channel:#staging-infra-monitoring}"
ROUTE_TARGET_LOW="${ROUTE_TARGET_LOW:-channel:#staging-infra-monitoring}"

if command -v timeout >/dev/null 2>&1; then
  HAS_TIMEOUT=1
else
  HAS_TIMEOUT=0
fi

run_with_timeout() {
  local timeout_value="$1"
  shift
  if [[ "$HAS_TIMEOUT" -eq 1 ]]; then
    timeout "$timeout_value" "$@"
  else
    "$@"
  fi
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
        gsub("(?i)(authorization:[[:space:]]*bearer[[:space:]]+)[A-Za-z0-9._=-]+"; "\\1<redacted>")
        | gsub("(?i)(xox[baprs]-)[A-Za-z0-9-]+"; "\\1<redacted>")
        | gsub("(?i)(xapp-[0-9]+-)[A-Za-z0-9-]+"; "\\1<redacted>")
        | gsub("(?i)(gh[pousr]_[A-Za-z0-9_]+)"; "<redacted-gh-token>")
        | gsub("(?i)github_pat_[A-Za-z0-9_]+"; "<redacted-gh-token>")
        | gsub("AKIA[0-9A-Z]{16}"; "<redacted-aws-key>")
        | gsub("ASIA[0-9A-Z]{16}"; "<redacted-aws-sts-key>")
        | gsub("[\r\n\t]+"; " ")
        | gsub("[[:space:]]+"; " ")
        | .[0:220]
      '
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
ensure_non_negative_int ALERT_COOLDOWN_SECONDS 1800
ensure_non_negative_int SEVERITY_CRITICAL_SCORE 85
ensure_non_negative_int SEVERITY_HIGH_SCORE 60
ensure_non_negative_int SEVERITY_MEDIUM_SCORE 30

pods_json="$(run_with_timeout "$KUBECTL_TIMEOUT" kubectl get pods -A -o json 2>/dev/null || printf '{"items":[]}\n')"
deploys_json="$(run_with_timeout "$KUBECTL_TIMEOUT" kubectl get deploy -A -o json 2>/dev/null || printf '{"items":[]}\n')"
events_json="$(run_with_timeout "$KUBECTL_TIMEOUT" kubectl get events -A -o json 2>/dev/null || printf '{"items":[]}\n')"
alerts_json="$(
  if command -v curl >/dev/null 2>&1; then
    run_with_timeout "${PROMETHEUS_TIMEOUT_SECONDS}s" \
      curl -fsS "${PROMETHEUS_URL}/api/v1/alerts" 2>/dev/null || printf '{"status":"error","data":{"alerts":[]}}\n'
  else
    printf '{"status":"error","data":{"alerts":[]}}\n'
  fi
)"

pod_rows="$(
  printf '%s\n' "$pods_json" | jq -r \
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
)" || pod_rows=""

container_state_rows="$(
  printf '%s\n' "$pods_json" | jq -r \
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
)" || container_state_rows=""

deploy_rows="$(
  printf '%s\n' "$deploys_json" | jq -r --argjson scopes "$NS_FILTER_JSON" '
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
)" || deploy_rows=""

event_rows="$(
  printf '%s\n' "$events_json" | jq -r --argjson scopes "$NS_FILTER_JSON" '
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
)" || event_rows=""

alert_rows="$(
  printf '%s\n' "$alerts_json" | jq -r --argjson ignored "$IGNORE_ALERTS_JSON" '
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
)" || alert_rows=""

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

log_signal_rows=""
if [[ "$INCLUDE_LOG_SNIPPETS" == "1" && -n "$container_state_rows" ]]; then
  target_count=0
  while IFS=$'\t' read -r ns pod container _kind _restarts _state _reason _exit_code _message; do
    [[ -z "${ns:-}" || -z "${pod:-}" || -z "${container:-}" ]] && continue
    if [[ "$target_count" -ge "$LOG_SNIPPET_PODS_LIMIT" ]]; then
      break
    fi

    current_logs="$(
      run_with_timeout "$KUBECTL_TIMEOUT" \
        kubectl -n "$ns" logs "$pod" -c "$container" --tail="$LOG_SNIPPET_LINES" 2>/dev/null || true
    )"
    if [[ -z "$current_logs" ]]; then
      current_logs="$(
        run_with_timeout "$KUBECTL_TIMEOUT" \
          kubectl -n "$ns" logs "$pod" -c "$container" --previous --tail="$LOG_SNIPPET_LINES" 2>/dev/null || true
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
      log_signal_rows="${log_signal_rows}${ns}"$'\t'"${pod}"$'\t'"${container}"$'\t'"${signal_kind}"$'\t'"${sanitized_line}"$'\n'
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
  done < <(printf '%s\n' "$container_state_rows")
fi
log_signal_rows="$(printf '%s' "$log_signal_rows" | awk 'NF > 0 { print }' | sort -u)" || log_signal_rows=""
log_signal_count="$(count_lines "$log_signal_rows")"
log_authz_count="$(
  printf '%s\n' "$log_signal_rows" | awk -F'\t' '$4 == "authz" { c++ } END { print c + 0 }'
)"
log_network_count="$(
  printf '%s\n' "$log_signal_rows" | awk -F'\t' '$4 == "network" { c++ } END { print c + 0 }'
)"
log_tls_count="$(
  printf '%s\n' "$log_signal_rows" | awk -F'\t' '$4 == "tls" { c++ } END { print c + 0 }'
)"
log_crash_count="$(
  printf '%s\n' "$log_signal_rows" | awk -F'\t' '$4 == "crash" { c++ } END { print c + 0 }'
)"
log_oom_count="$(
  printf '%s\n' "$log_signal_rows" | awk -F'\t' '$4 == "oom" { c++ } END { print c + 0 }'
)"

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
  log_signal_points \
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

impacted_pod_keys="$(
  printf '%s\n' "$pod_rows" \
    | awk -F'\t' 'NF >= 2 { print $1 "\t" $2 }' \
    | sort -u
)" || impacted_pod_keys=""

repo_map_rows=""
repo_map_note=""
if [[ "$INCLUDE_REPO_MAP" == "1" ]]; then
  image_repo_map_script="${RCA_SCRIPT_DIR%/}/image-repo-map.sh"
  workload_repo_map_file="/tmp/openclaw-image-repo/workload-image-repo.tsv"
  if [[ ! -f "$image_repo_map_script" ]]; then
    repo_map_note="image repo map script missing: ${image_repo_map_script}"
  elif [[ -z "$impacted_pod_keys" ]]; then
    repo_map_note="no impacted pods to map"
  elif bash "$image_repo_map_script" >/dev/null 2>&1 && [[ -f "$workload_repo_map_file" ]]; then
    repo_map_rows="$(
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
      ' <(printf '%s\n' "$impacted_pod_keys") "$workload_repo_map_file" | sort -u
    )" || repo_map_rows=""
    if [[ -z "$repo_map_rows" ]]; then
      repo_map_note="no repo mapping matches for impacted pods"
    fi
  else
    repo_map_note="image repo map execution failed"
  fi
else
  repo_map_note="repo mapping disabled (INCLUDE_REPO_MAP=${INCLUDE_REPO_MAP})"
fi

ci_rows=""
ci_note=""
if [[ "$INCLUDE_CI_SIGNAL" == "1" ]]; then
  ci_status_script="${RCA_SCRIPT_DIR%/}/github-ci-status.sh"
  if [[ ! -f "$ci_status_script" ]]; then
    ci_note="github ci status script missing: ${ci_status_script}"
  else
    repos_for_ci="$(
      printf '%s\n' "$repo_map_rows" \
        | awk -F'\t' 'NF >= 4 && $4 != "" { print $4 }' \
        | sort -u \
        | sed -n "1,${CI_REPO_LIMIT}p"
    )" || repos_for_ci=""
    if [[ -z "$repos_for_ci" ]]; then
      ci_note="no mapped repos to query"
    else
      while IFS= read -r repo; do
        [[ -z "$repo" ]] && continue
        ci_output="$(GITHUB_CI_STRICT=0 bash "$ci_status_script" --repo "$repo" --limit "$CI_RUN_LIMIT" 2>/dev/null || true)"
        ci_row="$(printf '%s\n' "$ci_output" | awk -F'\t' 'NR == 1 { next } NF >= 9 { print; exit }')"
        if [[ -n "$ci_row" ]]; then
          ci_rows="${ci_rows}${ci_row}"$'\n'
        fi
      done < <(printf '%s\n' "$repos_for_ci")
      ci_rows="$(printf '%s' "$ci_rows" | awk 'NF > 0 { print }')" || ci_rows=""
      if [[ -z "$ci_rows" ]]; then
        ci_note="github ci queries returned no rows"
      fi
    fi
  fi
else
  ci_note="github ci enrichment disabled (INCLUDE_CI_SIGNAL=${INCLUDE_CI_SIGNAL})"
fi

revision_rows=""
revision_note=""
suspect_pr_rows=""
suspect_pr_count=0
revision_resolved_count=0
if [[ "$INCLUDE_IMAGE_REVISION" == "1" ]]; then
  if [[ -z "$repo_map_rows" ]]; then
    revision_note="no impacted repo mappings for revision lookup"
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
          commit_resolved="$(
            git -C "$local_repo_path" rev-parse --short=12 "$commit_full" 2>/dev/null || printf '%s' "${commit_full:0:12}"
          )"
          commit_time="$(git -C "$local_repo_path" show -s --format='%cI' "$commit_full" 2>/dev/null || echo '-')"
          commit_subject_raw="$(git -C "$local_repo_path" show -s --format='%s' "$commit_full" 2>/dev/null || true)"
          commit_subject="$(sanitize_signal_line "$commit_subject_raw")"
          if [[ -z "$commit_subject" ]]; then
            commit_subject="-"
          fi
          revision_resolved_count=$((revision_resolved_count + 1))

          if command -v gh >/dev/null 2>&1 && [[ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]]; then
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
              suspect_pr_rows="${suspect_pr_rows}${repo}"$'\t'"${pr_number}"$'\t'"${pr_title}"$'\t'"${pr_state}"$'\t'"${pr_url}"$'\t'"${ns}"$'\t'"${pod}"$'\n'
            fi
          fi
        fi
      fi

      revision_rows="${revision_rows}${ns}"$'\t'"${pod}"$'\t'"${image}"$'\t'"${repo}"$'\t'"${image_tag:--}"$'\t'"${commit_hint:--}"$'\t'"${commit_resolved}"$'\t'"${commit_time}"$'\t'"${commit_subject}"$'\t'"${pr_number}"$'\t'"${pr_title}"$'\t'"${pr_state}"$'\t'"${pr_url}"$'\n'
      revision_processed=$((revision_processed + 1))
    done < <(printf '%s\n' "$repo_map_rows")

    revision_rows="$(printf '%s' "$revision_rows" | awk 'NF > 0 { print }')" || revision_rows=""
    suspect_pr_rows="$(printf '%s' "$suspect_pr_rows" | awk 'NF > 0 { print }' | sort -u)" || suspect_pr_rows=""
    suspect_pr_count="$(count_lines "$suspect_pr_rows")"

    if [[ -z "$revision_rows" ]]; then
      revision_note="unable to resolve image revision signals"
    elif [[ "$suspect_pr_count" -eq 0 ]]; then
      revision_note="no PR association found for resolved image revisions"
    fi
  fi
else
  revision_note="image revision enrichment disabled (INCLUDE_IMAGE_REVISION=${INCLUDE_IMAGE_REVISION})"
fi

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
    "kubectl -n <ns> describe pod <pod>; kubectl -n <ns> get deploy <name> -o yaml | rg -n 'secret|configMap'" \
    "Restore previous secretRef/configMapRef and rollout previous manifest"
fi

if [[ "$image_pull_count" -gt 0 ]]; then
  add_hypothesis \
    "90" \
    "high" \
    "Image pull failure (registry/tag/auth)" \
    "pods with ImagePullBackOff/ErrImagePull=${image_pull_count}" \
    "kubectl -n <ns> describe pod <pod>; check image tag and imagePullSecrets; verify ECR/GHCR auth" \
    "Rollback deployment to last known-good image tag"
fi

if [[ "$crashloop_count" -gt 0 ]]; then
  add_hypothesis \
    "85" \
    "high" \
    "Application runtime crash or bad startup config" \
    "pods with CrashLoop/OOM signatures=${crashloop_count}" \
    "kubectl -n <ns> logs <pod> --previous --tail=200; compare env/config delta vs last good release" \
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
    "kubectl -n <ns> top pod <pod>; kubectl -n <ns> get deploy <name> -o yaml | rg -n 'resources:'" \
    "Temporarily increase limits/requests or rollback to previous resource profile"
fi

if [[ "$log_authz_count" -gt 0 ]]; then
  add_hypothesis \
    "80" \
    "high" \
    "Runtime authorization failure (RBAC/credentials) seen in container logs" \
    "authz log signals=${log_authz_count}" \
    "kubectl -n <ns> logs <pod> -c <container> --previous --tail=200; verify serviceAccount RBAC, Vault/Argo token scopes, and mounted credentials" \
    "Revert credential/role changes; roll back to last known-good secret or service account mapping"
fi

if [[ "$log_network_count" -gt 0 || "$log_tls_count" -gt 0 ]]; then
  add_hypothesis \
    "72" \
    "medium" \
    "Network/TLS dependency failure surfaced in application logs" \
    "network log signals=${log_network_count}, tls log signals=${log_tls_count}" \
    "kubectl -n <ns> logs <pod> -c <container> --tail=200; check Service/Endpoint DNS, NetworkPolicy, and cert trust chain" \
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
    "kubectl -n <ns> rollout status deploy/<name>; kubectl -n <ns> describe deploy/<name>" \
    "Rollback rollout history to previous revision"
fi

if [[ "$hpa_metrics_count" -gt 0 ]]; then
  add_hypothesis \
    "65" \
    "medium" \
    "Metrics API unavailable for HPA" \
    "HPA events with pods.metrics.k8s.io missing=${hpa_metrics_count}" \
    "kubectl get apiservice | rg metrics.k8s.io; kubectl -n kube-system get pods | rg metrics-server" \
    "Disable impacted HPA or pin replicas until metrics API recovers"
fi

if [[ "$finding_cluster_count" -gt 0 ]]; then
  add_hypothesis \
    "60" \
    "medium" \
    "Stale CNPG backup resources target unknown cluster" \
    "FindingCluster unknown-cluster events=${finding_cluster_count}" \
    "kubectl -n <ns> get backup,scheduledbackup | rg <cluster-name>" \
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
if [[ "$pod_issue_count" -gt 0 || "$deploy_gap_count" -gt 0 || "$critical_alert_count" -gt 0 || "$image_pull_count" -gt 0 || "$create_config_count" -gt 0 || "$log_authz_count" -gt 0 || "$log_crash_count" -gt 0 ]]; then
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
          secret="unknown"
          if (match($5, /secret "[^"]+"/)) {
            raw=substr($5, RSTART, RLENGTH)
            gsub(/^secret "/, "", raw)
            gsub(/"$/, "", raw)
            secret=raw
          }
          print $1 "\t" $2 "\t" secret
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

  if [[ "$should_alert" == "yes" && "$state_store_ready" -eq 1 ]]; then
    {
      printf 'fingerprint\t%s\n' "$incident_fingerprint"
      printf 'last_alert_ts\t%s\n' "$now_ts"
    } >"$INCIDENT_STATE_FILE" 2>/dev/null || true
  elif [[ "$should_alert" == "yes" && "$state_store_ready" -eq 0 ]]; then
    gate_reason="${gate_reason}+state-store-unavailable"
  fi
fi

section "meta"
printf 'snapshot_utc\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'context\t%s\n' "$(kubectl config current-context 2>/dev/null || echo unknown)"
printf 'namespace_scope\t%s\n' "${SCOPE_NAMESPACES:-all}"

section "health_status"
if [[ "$incident" -eq 1 ]]; then
  printf 'state\tincident\n'
else
printf 'state\tok\n'
fi
printf 'incident_signals\t%s\n' "$((pod_issue_count + deploy_gap_count + critical_alert_count + image_pull_count + create_config_count + log_signal_count))"

section "incident_gate"
printf 'should_alert\t%s\n' "$should_alert"
printf 'gate_reason\t%s\n' "$gate_reason"
printf 'incident_fingerprint\t%s\n' "$incident_fingerprint"
printf 'cooldown_seconds\t%s\n' "$ALERT_COOLDOWN_SECONDS"
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
echo "1) kubectl -n <ns> describe pod <pod>"
echo "2) kubectl -n <ns> get events --sort-by=.lastTimestamp | tail -n 50"
echo "3) kubectl -n <ns> get deploy <name> -o yaml | rg -n 'image|secret|configMap|envFrom'"
echo "4) /home/node/.openclaw/skills/morpho-sre/scripts/image-repo-map.sh --image <workload-or-image>"
echo "5) /home/node/.openclaw/skills/morpho-sre/scripts/repo-clone.sh --image <workload-or-image>"
echo "6) /home/node/.openclaw/skills/morpho-sre/scripts/github-ci-status.sh --image <workload-or-image> --limit 5"
echo "7) kubectl -n <ns> logs <pod> -c <container> --tail=200 --previous"
echo "8) gh pr view <pr-number> -R <owner/repo> --json number,title,state,mergedAt,author,url"
