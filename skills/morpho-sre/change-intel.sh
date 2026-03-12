#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

IMAGE_REPO_MAP_SCRIPT="${CHANGE_INTEL_IMAGE_REPO_MAP_SCRIPT:-${SCRIPT_DIR}/image-repo-map.sh}"
GITHUB_CI_STATUS_SCRIPT="${CHANGE_INTEL_GITHUB_CI_STATUS_SCRIPT:-${SCRIPT_DIR}/github-ci-status.sh}"
ARGOCD_SYNC_STATUS_SCRIPT="${CHANGE_INTEL_ARGOCD_SYNC_STATUS_SCRIPT:-${SCRIPT_DIR}/argocd-sync-status.sh}"
HELM_LINEAGE_TRACKER_SCRIPT="${CHANGE_INTEL_HELM_LINEAGE_TRACKER_SCRIPT:-${SCRIPT_DIR}/helm-lineage-tracker.sh}"
EVIDENCE_ROW_SCRIPT="${CHANGE_INTEL_EVIDENCE_ROW_SCRIPT:-${SCRIPT_DIR}/lib-evidence-row.sh}"

IMAGE_FILTER="${CHANGE_INTEL_IMAGE_FILTER:-}"
SYMPTOM="${CHANGE_INTEL_SYMPTOM:-unknown symptom}"
LIMIT="${CHANGE_INTEL_LIMIT:-5}"

usage() {
  cat <<'EOF'
change-intel.sh --image <substring> [--symptom <text>] [--limit <n>]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE_FILTER="${2:-}"; shift 2 ;;
    --symptom) SYMPTOM="${2:-}"; shift 2 ;;
    --limit) LIMIT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -n "$IMAGE_FILTER" ]] || {
  echo "--image required" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || {
  echo "missing jq" >&2
  exit 1
}

source_if_present() {
  local script="${1:-}"
  [[ -n "$script" && -f "$script" ]] || return 0
  # shellcheck source=/dev/null
  source "$script"
}

source_if_present "$EVIDENCE_ROW_SCRIPT"

repo_map_tsv="$(mktemp)"
ci_status_tsv="$(mktemp)"
argocd_status_tsv="$(mktemp)"
trap 'rm -f "$repo_map_tsv" "$ci_status_tsv" "$argocd_status_tsv"' EXIT

bash "$IMAGE_REPO_MAP_SCRIPT" --image "$IMAGE_FILTER" >"$repo_map_tsv"
bash "$GITHUB_CI_STATUS_SCRIPT" --image "$IMAGE_FILTER" --limit "$LIMIT" >"$ci_status_tsv" 2>/dev/null || true
bash "$ARGOCD_SYNC_STATUS_SCRIPT" >"$argocd_status_tsv" 2>/dev/null || true

build_candidate_json() {
  local repo="$1"
  local mapping_source="$2"
  local workflow="$3"
  local status="$4"
  local conclusion="$5"
  local drift_summary="$6"

  local score=0
  local reasons=()
  [[ -n "$workflow" ]] && {
    score=$((score + 25))
    reasons+=("recent_ci")
  }
  [[ "$conclusion" == "failure" || "$conclusion" == "failed" ]] && {
    score=$((score + 40))
    reasons+=("ci_failure")
  }
  [[ "$status" == "in_progress" || "$status" == "queued" ]] && {
    score=$((score + 20))
    reasons+=("ci_active")
  }
  [[ "$drift_summary" == *"severity=critical"* ]] && {
    score=$((score + 35))
    reasons+=("argocd_drift_critical")
  }
  [[ "$drift_summary" == *"severity=warning"* ]] && {
    score=$((score + 15))
    reasons+=("argocd_drift_warning")
  }
  [[ -n "$mapping_source" ]] && reasons+=("image_repo_map")

  jq -nc \
    --arg repo "$repo" \
    --arg mapping_source "$mapping_source" \
    --arg workflow "$workflow" \
    --arg status "$status" \
    --arg conclusion "$conclusion" \
    --arg drift_summary "$drift_summary" \
    --arg symptom "$SYMPTOM" \
    --arg image_filter "$IMAGE_FILTER" \
    --argjson score "$score" \
    --argjson reasons "$(printf '%s\n' "${reasons[@]}" | jq -R . | jq -s '.')" '
      {
        repo: $repo,
        score: $score,
        symptom: $symptom,
        image_filter: $image_filter,
        mapping_source: $mapping_source,
        reasons: $reasons,
        ci: {
          workflow: $workflow,
          status: $status,
          conclusion: $conclusion
        },
        argocd: {
          drift_summary: $drift_summary
        }
      }'
}

evidence_row_for_candidate() {
  local repo="$1"
  local score="$2"
  local payload_json="$3"
  if declare -F evidence_row_build >/dev/null 2>&1; then
    evidence_row_build "change-intel" "change_candidate" "$repo" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$payload_json" "" "0.72" "900"
    return 0
  fi
  jq -nc \
    --arg repo "$repo" \
    --argjson score "$score" \
    --argjson payload "$payload_json" '
      {
        version: "sre.evidence-row.v1",
        source: "change-intel",
        kind: "change_candidate",
        scope: $repo,
        observed_at: (now | todateiso8601),
        ttl_seconds: 900,
        stale_after: ((now + 900) | todateiso8601),
        confidence: 0.72,
        entity_ids: [],
        payload: $payload,
        collection_error: ""
      }'
}

repos="$(
  awk -F'\t' '
    $1 == "namespace" { next }
    $5 == "" || $5 == "github_repo" { next }
    { print $5 "\t" $8 }
  ' "$repo_map_tsv" | sort -u
)"
argocd_drift="$(awk -F'\t' 'NR > 1 { print $1 "\t" $6 }' "$argocd_status_tsv" | sort -u)"

output_rows=()
while IFS=$'\t' read -r repo mapping_source; do
  [[ -n "$repo" ]] || continue
  workflow="$(awk -F'\t' -v repo="$repo" '$1 == repo { print $2; exit }' "$ci_status_tsv" 2>/dev/null || true)"
  ci_status="$(awk -F'\t' -v repo="$repo" '$1 == repo { print $4; exit }' "$ci_status_tsv" 2>/dev/null || true)"
  conclusion="$(awk -F'\t' -v repo="$repo" '$1 == repo { print $5; exit }' "$ci_status_tsv" 2>/dev/null || true)"
  drift_summary="$(awk -F'\t' -v repo="$repo" '$1 == repo { print $2; exit }' <(printf '%s\n' "$argocd_drift") 2>/dev/null || true)"
  candidate_json="$(build_candidate_json "$repo" "$mapping_source" "$workflow" "$ci_status" "$conclusion" "$drift_summary")"
  score="$(printf '%s\n' "$candidate_json" | jq -r '.score')"
  evidence_row="$(evidence_row_for_candidate "$repo" "$score" "$candidate_json")"
  output_rows+=("$(
    jq -nc \
      --argjson candidate "$candidate_json" \
      --argjson evidence_row "$evidence_row" '
        $candidate + {evidence_row: $evidence_row}'
  )")
done < <(printf '%s\n' "$repos")

printf '%s\n' "${output_rows[@]}" \
  | jq -cs --arg symptom "$SYMPTOM" --arg image_filter "$IMAGE_FILTER" '
      {
        version: "sre.change-intel.v1",
        generated_at: (now | todateiso8601),
        symptom: $symptom,
        image_filter: $image_filter,
        candidates: (sort_by(-(.score // 0)))
      }'
