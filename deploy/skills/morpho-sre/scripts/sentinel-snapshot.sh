#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

for cmd in awk bash date jq kubectl sed sort; do
  require_cmd "$cmd"
done

SCOPE_NAMESPACE="${SCOPE_NAMESPACE:-}"
POD_LIMIT="${POD_LIMIT:-60}"
DEPLOY_LIMIT="${DEPLOY_LIMIT:-40}"
EVENT_LIMIT="${EVENT_LIMIT:-40}"
ALERT_LIMIT="${ALERT_LIMIT:-40}"
RESTART_THRESHOLD="${RESTART_THRESHOLD:-3}"
KUBECTL_TIMEOUT="${KUBECTL_TIMEOUT:-20s}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://prometheus-stack-kube-prom-prometheus.monitoring.svc.cluster.local:9090}"
PROMETHEUS_TIMEOUT_SECONDS="${PROMETHEUS_TIMEOUT_SECONDS:-8}"

if command -v timeout >/dev/null 2>&1; then
  HAS_TIMEOUT=1
else
  HAS_TIMEOUT=0
fi

section() {
  printf '\n=== %s ===\n' "$1"
}

count_lines() {
  local data="$1"
  if [[ -z "$data" ]]; then
    printf '0\n'
    return
  fi
  printf '%s\n' "$data" | awk 'NF > 0 { c++ } END { print c + 0 }'
}

run_kubectl_scoped() {
  if [[ -n "$SCOPE_NAMESPACE" ]]; then
    run_with_timeout "$KUBECTL_TIMEOUT" kubectl "$@" -n "$SCOPE_NAMESPACE"
  else
    run_with_timeout "$KUBECTL_TIMEOUT" kubectl "$@" -A
  fi
}

run_kubectl_global() {
  run_with_timeout "$KUBECTL_TIMEOUT" kubectl "$@"
}

run_with_timeout() {
  local timeout_value="$1"
  shift
  if [[ "$HAS_TIMEOUT" -eq 1 ]]; then
    timeout "$timeout_value" "$@"
  else
    "$@"
  fi
}

section "meta"
printf 'snapshot_utc\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'context\t%s\n' "$(kubectl config current-context 2>/dev/null || echo unknown)"
printf 'namespace_scope\t%s\n' "${SCOPE_NAMESPACE:-all}"
printf 'node_count\t%s\n' "$(
  run_kubectl_global get nodes --no-headers 2>/dev/null \
    | awk 'NF > 0 { c++ } END { print c + 0 }'
)"

section "pod_anomalies"
printf 'namespace\tpod\tphase\trestarts\treasons\n'
pod_rows="$(
  run_kubectl_scoped get pods -o json | jq -r --argjson restartThreshold "$RESTART_THRESHOLD" '
    .items[]
    | .metadata.namespace as $ns
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
    | if ($phase != "Running" and $phase != "Succeeded") or ($restarts >= $restartThreshold) or ($reasons != "")
      then [$ns, $pod, $phase, ($restarts | tostring), (if $reasons == "" then "-" else $reasons end)] | @tsv
      else empty
      end
  ' 2>/dev/null | sort
)" || pod_rows=""
if [[ -n "$pod_rows" ]]; then
  printf '%s\n' "$pod_rows" | sed -n "1,${POD_LIMIT}p"
else
  echo "none"
fi

section "deployment_readiness_gaps"
printf 'namespace\tdeployment\tdesired\tavailable\tupdated\tunavailable\n'
deploy_rows="$(
  run_kubectl_scoped get deploy -o json | jq -r '
    .items[]
    | .metadata.namespace as $ns
    | .metadata.name as $name
    | (.spec.replicas // 1) as $desired
    | (.status.availableReplicas // 0) as $available
    | (.status.updatedReplicas // 0) as $updated
    | (.status.unavailableReplicas // 0) as $unavailable
    | if ($available < $desired) or ($unavailable > 0)
      then [$ns, $name, ($desired | tostring), ($available | tostring), ($updated | tostring), ($unavailable | tostring)] | @tsv
      else empty
      end
  ' 2>/dev/null | sort
)" || deploy_rows=""
if [[ -n "$deploy_rows" ]]; then
  printf '%s\n' "$deploy_rows" | sed -n "1,${DEPLOY_LIMIT}p"
else
  echo "none"
fi

section "warning_events_recent"
printf 'namespace\tobject\treason\tlast_seen\tmessage\n'
event_rows="$(
  run_kubectl_scoped get events --field-selector type!=Normal -o json | jq -r '
    .items
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
  ' 2>/dev/null
)" || event_rows=""
if [[ -n "$event_rows" ]]; then
  printf '%s\n' "$event_rows" | tail -n "$EVENT_LIMIT"
else
  echo "none"
fi

section "prometheus_firing_alerts"
printf 'severity\talertname\tnamespace\tpod\tjob\tactive_at\n'
alert_rows=""
if command -v curl >/dev/null 2>&1; then
  alert_rows="$(
    run_with_timeout "${PROMETHEUS_TIMEOUT_SECONDS}s" curl -fsS "${PROMETHEUS_URL}/api/v1/alerts" | jq -r '
      if .status != "success" then
        empty
      else
        .data.alerts[]
        | select(.state == "firing")
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
    ' 2>/dev/null | sort
  )" || alert_rows=""
fi
if [[ -n "$alert_rows" ]]; then
  printf '%s\n' "$alert_rows" | sed -n "1,${ALERT_LIMIT}p"
else
  echo "none"
fi

section "summary_counts"
printf 'pod_anomalies\t%s\n' "$(count_lines "$pod_rows")"
printf 'deployment_readiness_gaps\t%s\n' "$(count_lines "$deploy_rows")"
printf 'warning_events_recent\t%s\n' "$(count_lines "$event_rows")"
printf 'prometheus_firing_alerts\t%s\n' "$(count_lines "$alert_rows")"
