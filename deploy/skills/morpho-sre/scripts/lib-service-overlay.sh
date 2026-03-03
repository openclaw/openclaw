#!/usr/bin/env bash

_service_overlay_default_dir() {
  local script_dir
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s\n' "${script_dir%/}/../service-overlays"
}

SERVICE_OVERLAY_DIR="${SERVICE_OVERLAY_DIR:-$(_service_overlay_default_dir)}"

_overlay_parse_yaml_to_json() {
  local overlay_file="$1"

  if command -v yq >/dev/null 2>&1; then
    yq -o=json '.' "$overlay_file" 2>/dev/null
    return 0
  fi

  if command -v python3 >/dev/null 2>&1; then
    if python3 - <<'PY' >/dev/null 2>&1
import yaml
PY
    then
      python3 - "$overlay_file" <<'PY' 2>/dev/null
import json
import sys
import yaml
path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as fh:
    doc = yaml.safe_load(fh) or {}
print(json.dumps(doc, separators=(',', ':')))
PY
      return 0
    fi
  fi

  if command -v ruby >/dev/null 2>&1; then
    ruby -ryaml -rjson -e '
      begin
        doc = YAML.safe_load(File.read(ARGV[0]), aliases: true) || {}
        puts JSON.generate(doc)
      rescue StandardError
        exit 1
      end
    ' "$overlay_file" 2>/dev/null
    return 0
  fi

  return 1
}

load_service_overlay() {
  local cluster="$1"
  local namespace="$2"
  local service="$3"

  local overlay_file="${SERVICE_OVERLAY_DIR%/}/${service}.yaml"
  [[ -f "$overlay_file" ]] || return 0

  local overlay_json
  if ! overlay_json="$(_overlay_parse_yaml_to_json "$overlay_file")"; then
    return 0
  fi

  if ! command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$overlay_json"
    return 0
  fi

  local matched
  matched="$(printf '%s\n' "$overlay_json" | jq -c --arg cluster "$cluster" --arg ns "$namespace" --arg svc "$service" '
    select(
      (.cluster // "") == $cluster
      and (.namespace // "") == $ns
      and (.service // "") == $svc
    )
  ' 2>/dev/null || true)"

  if [[ -n "$matched" ]]; then
    printf '%s\n' "$matched"
  fi
  return 0
}

extract_known_failure_modes() {
  if ! command -v jq >/dev/null 2>&1; then
    cat
    return 0
  fi
  jq -r '.known_failure_modes // [] | map(.id // empty) | .[]'
}

format_overlay_context() {
  if ! command -v jq >/dev/null 2>&1; then
    cat
    return 0
  fi

  jq -r '
    ("Team: "
      + (.team // .owners.team // "unknown")
      + " ("
      + (.owners.primary // "unknown")
      + ", escalation: "
      + (.owners.escalation // "none")
      + ")")
    + "\nTier: " + (.tier // "standard")
    + "\nResource baseline: CPU " + (.resource_baseline.cpu_normal // "unknown")
    + ", Memory " + (.resource_baseline.memory_normal // "unknown")
    + (if (.resource_baseline.memory_oom_threshold // "") != "" then
        " (OOM at ~" + .resource_baseline.memory_oom_threshold + ")"
      else "" end)
    + "\n\nKnown failure modes:\n"
    + (
      (.known_failure_modes // [])
      | if length == 0 then
          "  (none)"
        else
          to_entries
          | map(
              "  \(.key + 1). \(.value.id // "unknown")"
              + (if (.value.pattern // "") != "" then " (pattern: \(.value.pattern))" else "" end)
              + (if (.value.remediation // "") != "" then "\n     -> \(.value.remediation)" else "" end)
            )
          | join("\n")
        end
    )
    + "\n\nSafe operations: " + ((.safe_operations // []) | if length == 0 then "none" else join(", ") end)
    + "\nUnsafe operations: " + ((.unsafe_operations // []) | if length == 0 then "none" else join(", ") end)
  '
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf 'library script; source this file\n' >&2
fi
