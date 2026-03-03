#!/usr/bin/env bash
set -euo pipefail

PROMETHEUS_URL="${PROMETHEUS_URL:-}"
SCOPE_NAMESPACES="${SCOPE_NAMESPACES:-morpho-dev,monitoring}"
PROMETHEUS_TIMEOUT_SECONDS="${PROMETHEUS_TIMEOUT_SECONDS:-8}"

if [[ -z "$PROMETHEUS_URL" ]]; then
  exit 0
fi

echo -e "metric_name\tpod\tcurrent_value\t6h_trend\t24h_trend\tthreshold_proximity\tstatus"

for cmd in awk; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo -e "collector\tcluster\tn/a\tn/a\tn/a\tn/a\tunknown"
    exit 0
  fi
done

if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  echo -e "collector\tcluster\tn/a\tn/a\tn/a\tn/a\tunknown"
  exit 0
fi

ns_regex="$(printf '%s' "$SCOPE_NAMESPACES" | tr ',' '|' | sed -E 's/[[:space:]]+//g')"
if [[ -z "$ns_regex" ]]; then
  ns_regex="morpho-dev|monitoring"
fi

fmt_pct() {
  local num="$1"
  awk -v n="$num" 'BEGIN { if (n == "" || n ~ /[^0-9.\-]/) { print "n/a"; } else { printf "%.1f%%", n; } }'
}

calc_delta_pct() {
  local current="$1"
  local previous="$2"
  awk -v c="$current" -v p="$previous" '
    BEGIN {
      if (c == "" || p == "" || c ~ /[^0-9.\-]/ || p ~ /[^0-9.\-]/ || p == 0) {
        print "n/a"
      } else {
        printf "%.1f%%", ((c - p) / p) * 100
      }
    }
  '
}

compare_ge() {
  local value="$1"
  local threshold="$2"
  awk -v v="$value" -v t="$threshold" 'BEGIN { if (v == "" || v ~ /[^0-9.\-]/) exit 1; exit !(v >= t) }'
}

prom_query_rows() {
  local query="$1"
  curl -fsS --max-time "$PROMETHEUS_TIMEOUT_SECONDS" -G "${PROMETHEUS_URL%/}/api/v1/query" \
    --data-urlencode "query=${query}" 2>/dev/null \
    | jq -r '.data.result[]? | [(.metric.pod // .metric.instance // "cluster"), (.value[1] // "0")] | @tsv' 2>/dev/null \
    || true
}

prom_query_value() {
  local query="$1"
  curl -fsS --max-time "$PROMETHEUS_TIMEOUT_SECONDS" -G "${PROMETHEUS_URL%/}/api/v1/query" \
    --data-urlencode "query=${query}" 2>/dev/null \
    | jq -r '.data.result[0]?.value[1] // ""' 2>/dev/null \
    || true
}

if ! curl -fsS --max-time "$PROMETHEUS_TIMEOUT_SECONDS" "${PROMETHEUS_URL%/}/api/v1/status/buildinfo" >/dev/null 2>&1; then
  echo -e "prometheus_api\tcluster\tn/a\tn/a\tn/a\tn/a\tunknown"
  exit 0
fi

while IFS=$'\t' read -r pod current; do
  [[ -z "$pod" ]] && continue

  pod_esc="$(printf '%s' "$pod" | sed 's/"/\\"/g')"

  limit="$(prom_query_value "sum(container_spec_memory_limit_bytes{namespace=~\"${ns_regex}\",pod=\"${pod_esc}\",container!=\"\"})")"
  prev_6h="$(prom_query_value "sum(container_memory_working_set_bytes{namespace=~\"${ns_regex}\",pod=\"${pod_esc}\",container!=\"\"} offset 6h)")"
  prev_24h="$(prom_query_value "sum(container_memory_working_set_bytes{namespace=~\"${ns_regex}\",pod=\"${pod_esc}\",container!=\"\"} offset 24h)")"

  proximity_raw=""
  if [[ -n "$limit" ]]; then
    proximity_raw="$(awk -v c="$current" -v l="$limit" 'BEGIN { if (l+0 > 0) printf "%.1f", (c/l)*100; }')"
  fi

  trend_6h="$(calc_delta_pct "$current" "$prev_6h")"
  trend_24h="$(calc_delta_pct "$current" "$prev_24h")"
  proximity="$(fmt_pct "$proximity_raw")"

  status="ok"
  if compare_ge "${proximity_raw:-}" 90; then
    status="critical"
  elif compare_ge "${proximity_raw:-}" 80; then
    status="warning"
  elif [[ "$trend_6h" != "n/a" ]] && compare_ge "${trend_6h%%%}" 10; then
    status="warning"
  fi

  if [[ "$status" != "ok" ]]; then
    echo -e "container_memory_working_set\t${pod}\t${current}\t${trend_6h}\t${trend_24h}\t${proximity}\t${status}"
  fi
done < <(prom_query_rows "sum by (pod) (container_memory_working_set_bytes{namespace=~\"${ns_regex}\",container!=\"\",pod!=\"\"})")

while IFS=$'\t' read -r pod restarts; do
  [[ -z "$pod" ]] && continue
  status="ok"
  if compare_ge "$restarts" 5; then
    status="critical"
  elif compare_ge "$restarts" 2; then
    status="warning"
  fi
  if [[ "$status" != "ok" ]]; then
    echo -e "pod_restart_rate_1h\t${pod}\t${restarts}\tn/a\tn/a\tn/a\t${status}"
  fi
done < <(prom_query_rows "sum by (pod) (increase(kube_pod_container_status_restarts_total{namespace=~\"${ns_regex}\"}[1h]))")

while IFS=$'\t' read -r pod throttled; do
  [[ -z "$pod" ]] && continue
  status="ok"
  if compare_ge "$throttled" 50; then
    status="critical"
  elif compare_ge "$throttled" 25; then
    status="warning"
  fi
  if [[ "$status" != "ok" ]]; then
    echo -e "cpu_throttle_pct\t${pod}\t$(fmt_pct "$throttled")\tn/a\tn/a\tn/a\t${status}"
  fi
done < <(prom_query_rows "sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{namespace=~\"${ns_regex}\",pod!=\"\"}[5m]) / clamp_min(rate(container_cpu_cfs_periods_total{namespace=~\"${ns_regex}\",pod!=\"\"}[5m]), 0.0001) * 100)")

while IFS=$'\t' read -r pod rate_5xx; do
  [[ -z "$pod" ]] && continue
  status="ok"
  if compare_ge "$rate_5xx" 5; then
    status="critical"
  elif compare_ge "$rate_5xx" 1; then
    status="warning"
  fi
  if [[ "$status" != "ok" ]]; then
    echo -e "http_5xx_rate_pct\t${pod}\t$(fmt_pct "$rate_5xx")\tn/a\tn/a\tn/a\t${status}"
  fi
done < <(prom_query_rows "sum by (pod) (rate(http_requests_total{namespace=~\"${ns_regex}\",code=~\"5..\",pod!=\"\"}[1h])) / clamp_min(sum by (pod) (rate(http_requests_total{namespace=~\"${ns_regex}\",pod!=\"\"}[1h])), 0.0001) * 100")
