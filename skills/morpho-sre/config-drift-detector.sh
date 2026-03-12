#!/usr/bin/env bash
set -euo pipefail

RENDERED_FILE="${CONFIG_DRIFT_RENDERED_FILE:-}"
LIVE_FILE="${CONFIG_DRIFT_LIVE_FILE:-}"
SCOPE="${CONFIG_DRIFT_SCOPE:-openclaw-sre}"

usage() {
  cat <<'EOF'
config-drift-detector.sh [--rendered-file <path>] [--live-file <path>] [--scope <value>]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rendered-file) RENDERED_FILE="${2:-}"; shift 2 ;;
    --live-file) LIVE_FILE="${2:-}"; shift 2 ;;
    --scope) SCOPE="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done

command -v jq >/dev/null 2>&1 || exit 0
[[ -n "$RENDERED_FILE" && -n "$LIVE_FILE" && -f "$RENDERED_FILE" && -f "$LIVE_FILE" ]] || exit 0

emit_row() {
  local field="$1"
  local severity="$2"
  local rendered_json="$3"
  local live_json="$4"
  jq -nc \
    --arg scope "$SCOPE" \
    --arg field "$field" \
    --arg severity "$severity" \
    --argjson rendered "$rendered_json" \
    --argjson live "$live_json" \
    '{
      version: "sre.evidence-row.v1",
      source: "config-drift-detector",
      kind: "config_drift",
      scope: $scope,
      observed_at: (now | todateiso8601),
      ttl_seconds: 900,
      stale_after: ((now + 900) | todateiso8601),
      confidence: 0.82,
      entity_ids: [],
      payload: {
        field: $field,
        severity: $severity,
        rendered: $rendered,
        live: $live
      },
      collection_error: ""
    }'
}

compare_field() {
  local field="$1"
  local severity="$2"
  local jq_path="$3"
  local rendered live
  rendered="$(jq -c "$jq_path" "$RENDERED_FILE" 2>/dev/null || printf 'null')"
  live="$(jq -c "$jq_path" "$LIVE_FILE" 2>/dev/null || printf 'null')"
  [[ "$rendered" == "$live" ]] && return 0
  emit_row "$field" "$severity" "$rendered" "$live"
}

compare_field image critical '.spec.template.spec.containers // [] | map({name, image})'
compare_field resources critical '.spec.template.spec.containers // [] | map({name, resources})'
compare_field env warning '.spec.template.spec.containers // [] | map({name, env, envFrom})'
compare_field replicas critical '.spec.replicas'
compare_field probes critical '.spec.template.spec.containers // [] | map({name, livenessProbe, readinessProbe, startupProbe})'
compare_field annotations warning '.spec.template.metadata.annotations // {}'
