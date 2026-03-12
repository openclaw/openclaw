#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-eu-west-3}}"
AWS_PROFILE="${AWS_PROFILE:-}"
COST_CURRENCY="${COST_CURRENCY:-USD}"
REPORT_DATE="$(date -u +%Y-%m-%d)"

aws_cmd() {
  local args=(--region "$AWS_REGION")
  if [[ -n "$AWS_PROFILE" ]]; then
    args+=(--profile "$AWS_PROFILE")
  fi
  AWS_PAGER="" aws "${args[@]}" "$@"
}

iso_date() {
  local expr="$1"
  date -u -d "$expr" +%Y-%m-%d 2>/dev/null || date -u -v"$expr" +%Y-%m-%d 2>/dev/null
}

current_start="$(date -u +%Y-%m-01)"
current_end="$(iso_date '+1 day')"
prev_start="$(date -u -d "${current_start} -1 month" +%Y-%m-01 2>/dev/null || date -u -v-1m -j -f %Y-%m-%d "$current_start" +%Y-%m-01 2>/dev/null || echo "$current_start")"
prev_end="$current_start"

echo "*Daily Cost Report* - ${REPORT_DATE}"

if ! command -v aws >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  echo "*MTD Spend:* n/a (prev month: n/a, delta: n/a)"
  echo "*Top services:* n/a"
  echo "*Anomalies:* unable to query (missing aws/jq)"
  exit 0
fi

if ! aws_cmd sts get-caller-identity >/dev/null 2>&1; then
  echo "*MTD Spend:* n/a (prev month: n/a, delta: n/a)"
  echo "*Top services:* n/a"
  echo "*Anomalies:* unable to query AWS credentials"
  exit 0
fi

current_json="$(aws_cmd ce get-cost-and-usage \
  --time-period Start="$current_start",End="$current_end" \
  --granularity MONTHLY \
  --metrics UnblendedCost 2>/dev/null || true)"
prev_json="$(aws_cmd ce get-cost-and-usage \
  --time-period Start="$prev_start",End="$prev_end" \
  --granularity MONTHLY \
  --metrics UnblendedCost 2>/dev/null || true)"

top_json="$(aws_cmd ce get-cost-and-usage \
  --time-period Start="$current_start",End="$current_end" \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE 2>/dev/null || true)"

current_amount="$(printf '%s\n' "$current_json" | jq -r '.ResultsByTime[0].Total.UnblendedCost.Amount // empty' 2>/dev/null || true)"
prev_amount="$(printf '%s\n' "$prev_json" | jq -r '.ResultsByTime[0].Total.UnblendedCost.Amount // empty' 2>/dev/null || true)"

if [[ -z "$current_amount" || -z "$prev_amount" ]]; then
  echo "*MTD Spend:* n/a (prev month: n/a, delta: n/a)"
else
  delta_pct="$(awk -v c="$current_amount" -v p="$prev_amount" 'BEGIN { if (p == 0) print "n/a"; else printf "%.1f", ((c-p)/p)*100 }')"
  delta_display="${delta_pct}%"
  if [[ "$delta_pct" != "n/a" && "${delta_pct#-}" != "$delta_pct" ]]; then
    delta_display="${delta_pct}%"
  elif [[ "$delta_pct" != "n/a" ]]; then
    delta_display="+${delta_pct}%"
  fi
  echo "*MTD Spend:* ${current_amount} ${COST_CURRENCY} (prev month: ${prev_amount} ${COST_CURRENCY}, delta: ${delta_display})"
fi

top_services="$(printf '%s\n' "$top_json" | jq -r '
  [.ResultsByTime[0].Groups[]?
   | {name: .Keys[0], amount: (.Metrics.UnblendedCost.Amount|tonumber)}]
  | sort_by(-.amount)
  | .[:5]
  | map("\(.name) \(.amount)")
  | join(", ")
' 2>/dev/null || true)"

if [[ -z "$top_services" || "$top_services" == "null" ]]; then
  top_services="n/a"
fi
echo "*Top services:* ${top_services}"

anomaly_msg="none"
if [[ -n "${current_amount:-}" && -n "${prev_amount:-}" ]]; then
  delta_abs="$(awk -v c="$current_amount" -v p="$prev_amount" 'BEGIN { if (p == 0) print 0; else print ((c-p)/p)*100 }')"
  if awk -v d="$delta_abs" 'BEGIN { exit !(d > 20 || d < -20) }'; then
    if awk -v d="$delta_abs" 'BEGIN { exit !(d > 0) }'; then
      anomaly_msg="spend increased by $(printf '%.1f' "$delta_abs")% vs previous month"
    else
      anomaly_msg="spend decreased by $(printf '%.1f' "${delta_abs#-}")% vs previous month"
    fi
  fi
fi

echo "*Anomalies:* ${anomaly_msg}"
