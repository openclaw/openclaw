#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
GRAPH_DIR="${OPENCLAW_SRE_GRAPH_DIR:-${STATE_DIR}/state/sre-graph}"
INDEX_DIR="${OPENCLAW_SRE_INDEX_DIR:-${STATE_DIR}/state/sre-index}"
DOSSIERS_DIR="${OPENCLAW_SRE_DOSSIERS_DIR:-${STATE_DIR}/state/sre-dossiers}"
SHADOW_RETENTION_DAYS="${SRE_SHADOW_RETENTION_DAYS:-7}"

shadow_dir="${INDEX_DIR%/}/shadow-evidence"
nodes_file="${GRAPH_DIR%/}/nodes.ndjson"
edges_file="${GRAPH_DIR%/}/edges.ndjson"

compact_ndjson_by_key() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  tmp="$(mktemp)"
  jq -cs --arg key "$key" '
    map(select(type == "object"))
    | map(select(.[$key] != null))
    | reduce .[] as $item ({}; .[$item[$key]] = $item)
    | .[]
  ' "$file" >"$tmp"
  if [[ -s "$tmp" ]]; then
    mv "$tmp" "$file"
  else
    rm -f "$tmp"
  fi
}

prune_shadow_evidence() {
  [[ -d "$shadow_dir" ]] || return 0
  find "$shadow_dir" -type f -mtime +"$SHADOW_RETENTION_DAYS" -delete
}

prune_empty_dossiers() {
  [[ -d "$DOSSIERS_DIR" ]] || return 0
  find "$DOSSIERS_DIR" -mindepth 1 -maxdepth 1 -type d | while IFS= read -r dir; do
    if ! find "$dir" -type f | read -r _; then
      rmdir "$dir" 2>/dev/null || true
    fi
  done
}

prune_shadow_evidence
compact_ndjson_by_key "$nodes_file" "entityId"
compact_ndjson_by_key "$edges_file" "edgeId"
prune_empty_dossiers

printf '{"status":"ok","shadow_retention_days":%s,"graph_dir":"%s","shadow_dir":"%s"}\n' \
  "$SHADOW_RETENTION_DAYS" "$GRAPH_DIR" "$shadow_dir"
