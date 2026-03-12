#!/usr/bin/env bash

incident_dossier_root_dir() {
  printf '%s\n' "${OPENCLAW_SRE_DOSSIERS_DIR:-/home/node/.openclaw/state/sre-dossiers}"
}

incident_dossier_id_dir() {
  local incident_id="${1:?incident_id required}"
  local safe_id
  safe_id="$(printf '%s' "$incident_id" | sed -E 's/[^A-Za-z0-9._:-]+/_/g')"
  printf '%s/%s\n' "$(incident_dossier_root_dir)" "$safe_id"
}

incident_dossier_write_file() {
  local incident_id="${1:?incident_id required}"
  local filename="${2:?filename required}"
  local content="${3:-}"
  local dossier_dir tmp_file target_file

  dossier_dir="$(incident_dossier_id_dir "$incident_id")"
  mkdir -p "$dossier_dir"
  target_file="${dossier_dir}/${filename}"
  tmp_file="${target_file}.tmp.$$"
  printf '%s' "$content" >"$tmp_file"
  mv -f "$tmp_file" "$target_file"
}

incident_dossier_summary_md() {
  local incident_id="${1:-unknown}"
  local namespace="${2:-unknown}"
  local category="${3:-unknown}"
  local severity="${4:-unknown}"
  local status="${5:-shadow}"
  cat <<EOF
# ${incident_id}

- Namespace: ${namespace}
- Category: ${category}
- Severity: ${severity}
- Status: ${status}
EOF
}

incident_dossier_write_bundle() {
  local incident_id="${1:?incident_id required}"
  local namespace="${2:-unknown}"
  local category="${3:-unknown}"
  local severity="${4:-unknown}"
  local incident_json="${5-}"
  local timeline_ndjson="${6:-}"
  local evidence_ndjson="${7:-}"
  local hypotheses_json="${8-}"
  local actions_json="${9-}"
  local entities_json="${10-}"
  local links_json="${11-}"
  [[ -n "$incident_json" ]] || incident_json='{}'
  [[ -n "$hypotheses_json" ]] || hypotheses_json='[]'
  [[ -n "$actions_json" ]] || actions_json='[]'
  [[ -n "$entities_json" ]] || entities_json='[]'
  [[ -n "$links_json" ]] || links_json='[]'

  incident_dossier_write_file "$incident_id" "summary.md" \
    "$(incident_dossier_summary_md "$incident_id" "$namespace" "$category" "$severity" "shadow")"$'\n'
  incident_dossier_write_file "$incident_id" "incident.json" "${incident_json}"$'\n'
  incident_dossier_write_file "$incident_id" "timeline.ndjson" "$timeline_ndjson"
  incident_dossier_write_file "$incident_id" "evidence.ndjson" "$evidence_ndjson"
  incident_dossier_write_file "$incident_id" "hypotheses.json" "${hypotheses_json}"$'\n'
  incident_dossier_write_file "$incident_id" "actions.json" "${actions_json}"$'\n'
  incident_dossier_write_file "$incident_id" "entities.json" "${entities_json}"$'\n'
  incident_dossier_write_file "$incident_id" "links.json" "${links_json}"$'\n'
}
