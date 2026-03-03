#!/usr/bin/env bash

SERVICE_GRAPH_FILE="${SERVICE_GRAPH_FILE:-${INCIDENT_STATE_DIR:-/tmp/openclaw-state}/service-graph.json}"
SERVICE_GRAPH_LOCK="${SERVICE_GRAPH_LOCK:-${SERVICE_GRAPH_FILE}.lock}"
SERVICE_GRAPH_TIERS="${SERVICE_GRAPH_TIERS:-t1}"
SERVICE_GRAPH_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RELATIONSHIP_KNOWLEDGE_ENABLED="${RELATIONSHIP_KNOWLEDGE_ENABLED:-1}"
RELATIONSHIP_KNOWLEDGE_BUILDER="${RELATIONSHIP_KNOWLEDGE_BUILDER:-${SERVICE_GRAPH_SCRIPT_DIR}/relationship-knowledge-build.sh}"
RELATIONSHIP_KNOWLEDGE_TIMEOUT_SECONDS="${RELATIONSHIP_KNOWLEDGE_TIMEOUT_SECONDS:-8}"
RELATIONSHIP_KNOWLEDGE_CACHE_FILE="${RELATIONSHIP_KNOWLEDGE_CACHE_FILE:-${INCIDENT_STATE_DIR:-/tmp/openclaw-state}/relationship-knowledge-cache.json}"
RELATIONSHIP_KNOWLEDGE_CACHE_TTL_SECONDS="${RELATIONSHIP_KNOWLEDGE_CACHE_TTL_SECONDS:-300}"

_sg_utc_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

_sg_fsync_path() {
  local path="$1"
  [[ -e "$path" ]] || return 0

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$path" >/dev/null 2>&1 <<'PY' || true
import os
import sys
p = sys.argv[1]
try:
    fd = os.open(p, os.O_RDONLY)
    os.fsync(fd)
    os.close(fd)
except Exception:
    pass
PY
    return 0
  fi

  if command -v perl >/dev/null 2>&1; then
    perl -MPOSIX -e 'open my $fh,"<",$ARGV[0] or exit 0; eval { POSIX::fsync(fileno($fh)); }; close $fh;' "$path" >/dev/null 2>&1 || true
  fi
}

_sg_fsync_dir() {
  local dir_path="$1"
  [[ -d "$dir_path" ]] || return 0

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$dir_path" >/dev/null 2>&1 <<'PY' || true
import os
import sys
p = sys.argv[1]
try:
    fd = os.open(p, os.O_RDONLY)
    os.fsync(fd)
    os.close(fd)
except Exception:
    pass
PY
    return 0
  fi

  if command -v perl >/dev/null 2>&1; then
    perl -MPOSIX -e 'opendir(my $dh,$ARGV[0]) or exit 0; my $fd = dirfd($dh); eval { POSIX::fsync($fd) if defined $fd; }; closedir($dh);' "$dir_path" >/dev/null 2>&1 || true
  fi
}

_sg_atomic_replace() {
  local target_file="$1"
  local tmp_file="$2"
  _sg_fsync_path "$tmp_file"
  mv -f "$tmp_file" "$target_file"
  _sg_fsync_dir "${target_file%/*}"
}

_sg_with_lock() {
  local lock_file="$1"
  shift

  mkdir -p "${lock_file%/*}"

  if command -v flock >/dev/null 2>&1; then
    local fd
    exec {fd}>"$lock_file"
    flock -x "$fd"
    local rc=0
    if "$@"; then
      rc=0
    else
      rc=$?
    fi
    flock -u "$fd" >/dev/null 2>&1 || true
    eval "exec ${fd}>&-"
    return "$rc"
  fi

  local lock_dir="${lock_file}.d"
  local tries=0
  while ! mkdir "$lock_dir" 2>/dev/null; do
    sleep 0.05
    tries=$((tries + 1))
    if [[ "$tries" -ge 400 ]]; then
      printf 'service graph lock timeout: %s\n' "$lock_file" >&2
      return 1
    fi
  done

  local rc=0
  if "$@"; then
    rc=0
  else
    rc=$?
  fi
  rmdir "$lock_dir" >/dev/null 2>&1 || true
  return "$rc"
}

_sg_tiers_json() {
  if ! command -v jq >/dev/null 2>&1; then
    printf '["t1"]\n'
    return 0
  fi

  local raw="${SERVICE_GRAPH_TIERS:-t1}"
  printf '%s\n' "$raw" | jq -Rc '
    split(",")
    | map(ascii_downcase | gsub("^\\s+|\\s+$"; ""))
    | map(select(length > 0))
    | if index("t1") == null then ["t1"] + . else . end
    | unique
  '
}

_sg_is_non_negative_int() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

_sg_bool_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

_sg_json_is_valid() {
  local json_payload="$1"
  printf '%s\n' "$json_payload" | jq -e . >/dev/null 2>&1
}

_sg_file_mtime_epoch() {
  local file_path="$1"
  [[ -e "$file_path" ]] || return 1

  if stat -f %m "$file_path" >/dev/null 2>&1; then
    stat -f %m "$file_path"
    return 0
  fi

  if stat -c %Y "$file_path" >/dev/null 2>&1; then
    stat -c %Y "$file_path"
    return 0
  fi

  return 1
}

_sg_run_with_timeout() {
  local timeout_s="$1"
  shift

  if _sg_is_non_negative_int "$timeout_s" && (( timeout_s > 0 )); then
    if command -v timeout >/dev/null 2>&1; then
      timeout "${timeout_s}s" "$@"
      return $?
    fi
    if command -v gtimeout >/dev/null 2>&1; then
      gtimeout "${timeout_s}s" "$@"
      return $?
    fi
  fi

  "$@"
}

_sg_relationship_payload_summary_json() {
  local payload_json="$1"
  printf '%s\n' "$payload_json" | jq -c '
    if type == "object" then
      {
        payload_type: "object",
        top_level_keys: (keys | length),
        relationship_count: (
          (.relationships // .edges // .links // [])
          | if type == "array" then length else 0 end
        )
      }
    elif type == "array" then
      {
        payload_type: "array",
        array_items: length
      }
    else
      {
        payload_type: type
      }
    end
  '
}

_sg_write_relationship_cache() {
  local cache_file="$1"
  local payload_json="$2"
  local cache_dir tmp_file

  cache_dir="$(dirname -- "$cache_file")"
  mkdir -p "$cache_dir"
  tmp_file="${cache_file}.tmp.$$"
  printf '%s\n' "$payload_json" >"$tmp_file"
  _sg_atomic_replace "$cache_file" "$tmp_file"
}

_sg_relationship_knowledge_summary() {
  if ! command -v jq >/dev/null 2>&1; then
    return 1
  fi
  if ! _sg_bool_true "${RELATIONSHIP_KNOWLEDGE_ENABLED:-1}"; then
    return 1
  fi

  local builder_path="${RELATIONSHIP_KNOWLEDGE_BUILDER:-${SERVICE_GRAPH_SCRIPT_DIR}/relationship-knowledge-build.sh}"
  local cache_file="${RELATIONSHIP_KNOWLEDGE_CACHE_FILE:-${INCIDENT_STATE_DIR:-/tmp/openclaw-state}/relationship-knowledge-cache.json}"
  local timeout_s="${RELATIONSHIP_KNOWLEDGE_TIMEOUT_SECONDS:-8}"
  local cache_ttl_s="${RELATIONSHIP_KNOWLEDGE_CACHE_TTL_SECONDS:-300}"

  _sg_is_non_negative_int "$timeout_s" || timeout_s=8
  _sg_is_non_negative_int "$cache_ttl_s" || cache_ttl_s=300

  local now_epoch cache_mtime cache_age cached_payload
  now_epoch="$(date +%s)"

  if [[ -s "$cache_file" ]]; then
    cache_mtime="$(_sg_file_mtime_epoch "$cache_file" || true)"
    if _sg_is_non_negative_int "$cache_mtime"; then
      cache_age=$((now_epoch - cache_mtime))
      if (( cache_age < 0 )); then
        cache_age=0
      fi
      if (( cache_age <= cache_ttl_s )); then
        cached_payload="$(cat "$cache_file" 2>/dev/null || true)"
        if _sg_json_is_valid "$cached_payload"; then
          jq -cn \
            --arg builder "$(basename -- "$builder_path")" \
            --arg builder_path "$builder_path" \
            --arg generated_at "$(_sg_utc_iso)" \
            --argjson cache_hit true \
            --argjson cache_age_seconds "$cache_age" \
            --argjson cache_ttl_seconds "$cache_ttl_s" \
            --argjson payload "$(_sg_relationship_payload_summary_json "$cached_payload")" \
            '{
              source: $builder,
              builder_path: $builder_path,
              generated_at: $generated_at,
              cache_hit: $cache_hit,
              cache_age_seconds: $cache_age_seconds,
              cache_ttl_seconds: $cache_ttl_seconds,
              payload: $payload
            }'
          return 0
        fi
      fi
    fi
  fi

  if [[ ! -f "$builder_path" ]]; then
    return 1
  fi

  local tmp_out tmp_err payload_json run_dir run_main_json
  tmp_out="$(mktemp)"
  tmp_err="$(mktemp)"
  run_dir="$(mktemp -d)"
  run_main_json="${run_dir}/initial-knowledge.v1.json"
  if _sg_run_with_timeout "$timeout_s" bash "$builder_path" --output-dir "$run_dir" >"$tmp_out" 2>"$tmp_err"; then
    payload_json=""
    if [[ -s "$run_main_json" ]]; then
      payload_json="$(cat "$run_main_json" 2>/dev/null || true)"
    else
      # Backward compatibility with builders that emit JSON directly to stdout.
      payload_json="$(cat "$tmp_out" 2>/dev/null || true)"
    fi
    if _sg_json_is_valid "$payload_json"; then
      _sg_write_relationship_cache "$cache_file" "$payload_json"
      rm -f "$tmp_out" "$tmp_err"
      rm -rf "$run_dir"
      jq -cn \
        --arg builder "$(basename -- "$builder_path")" \
        --arg builder_path "$builder_path" \
        --arg generated_at "$(_sg_utc_iso)" \
        --argjson cache_hit false \
        --argjson cache_age_seconds 0 \
        --argjson cache_ttl_seconds "$cache_ttl_s" \
        --argjson payload "$(_sg_relationship_payload_summary_json "$payload_json")" \
        '{
          source: $builder,
          builder_path: $builder_path,
          generated_at: $generated_at,
          cache_hit: $cache_hit,
          cache_age_seconds: $cache_age_seconds,
          cache_ttl_seconds: $cache_ttl_seconds,
          payload: $payload
        }'
      return 0
    fi
  fi
  rm -f "$tmp_out" "$tmp_err"
  rm -rf "$run_dir"
  return 1
}

_sg_safe_kubectl_json() {
  local namespace="$1"
  local resource="$2"

  local -a cmd=(kubectl)
  if [[ -n "${K8S_CONTEXT:-}" ]]; then
    cmd+=(--context "$K8S_CONTEXT")
  fi
  cmd+=(-n "$namespace" get "$resource" -o json)

  local out
  if ! out="$("${cmd[@]}" 2>/dev/null)"; then
    printf '{"items":[]}\n'
    return 0
  fi

  if command -v jq >/dev/null 2>&1; then
    if ! printf '%s\n' "$out" | jq -e . >/dev/null 2>&1; then
      printf '{"items":[]}\n'
      return 0
    fi
  fi

  printf '%s\n' "$out"
}

_sg_discover_t1_namespace() {
  local namespace="$1"

  if ! command -v jq >/dev/null 2>&1; then
    printf '{}\n'
    return 0
  fi

  local deployments_json services_json
  deployments_json="$(_sg_safe_kubectl_json "$namespace" deployments)"
  services_json="$(_sg_safe_kubectl_json "$namespace" services)"

  jq -cn --arg ns "$namespace" --argjson deploys "$deployments_json" --argjson svcs "$services_json" '
    def selectors_match($selector; $labels):
      ($selector | to_entries | all(($labels[.key] // null) == .value));

    ($svcs.items // []) as $svc_items
    | ($deploys.items // []) as $deploy_items

    | reduce $deploy_items[] as $d ({};
        ($d.metadata.labels // $d.spec.template.metadata.labels // {}) as $labels
        | ([
            $svc_items[]?
            | select((.spec.selector // {}) != {} and selectors_match((.spec.selector // {}); $labels))
            | .metadata.name
          ] | first // $d.metadata.name) as $resolved_name
        | ("\($ns)/\($resolved_name // "")") as $key
        | if $key == ("\($ns)/") then . else
            .[$key] = {
              namespace: $ns,
              team: ($d.metadata.labels.team // $d.spec.template.metadata.labels.team // "unknown"),
              tier: ($d.metadata.labels.tier // $d.spec.template.metadata.labels.tier // "standard"),
              depends_on: (
                [
                  ($d.spec.template.spec.containers // [])[]?
                  | (.env // [])[]?
                  | (.value // "")
                  | match("(?<svc>[a-z0-9][a-z0-9-]*)\\.(?<dns_ns>[a-z0-9][a-z0-9-]*)\\.svc"; "g")?
                  | (.captures | map({key: .name, value: .string}) | from_entries) as $m
                  | {
                      service: "\($m.dns_ns)/\($m.svc)",
                      edge_type: "depends-on",
                      discovery_tier: "t1"
                    }
                ]
                | unique_by(.service)
              ),
              depended_by: []
            }
          end
      )

    | reduce $svc_items[] as $svc (.;
        ("\($ns)/\($svc.metadata.name // "")") as $svc_key
        | if $svc_key == ("\($ns)/") then . else
            .[$svc_key] = ((.[$svc_key] // {
              namespace: $ns,
              team: "unknown",
              tier: "standard",
              depends_on: [],
              depended_by: []
            })
            | .namespace = (.namespace // $ns)
            | .team = (.team // "unknown")
            | .tier = (.tier // "standard")
            | .depends_on = (.depends_on // [])
            | .depended_by = (.depended_by // [])
            )
          end
      )
  '
}

_sg_add_reverse_edges() {
  local services_json="$1"

  if ! command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$services_json"
    return 0
  fi

  printf '%s\n' "$services_json" | jq '
    . as $svc_map
    | reduce (
        keys[] as $source
        | ($svc_map[$source].depends_on // [])[]?
        | {
            source: $source,
            target: (.service // ""),
            edge_type: (.edge_type // "depends-on"),
            discovery_tier: (.discovery_tier // "t1")
          }
      ) as $edge ($svc_map;
        if ($edge.target != "" and .[$edge.target]) then
          .[$edge.target].depended_by += [{
            service: $edge.source,
            edge_type: $edge.edge_type,
            discovery_tier: $edge.discovery_tier
          }]
        else
          .
        end
      )
    | with_entries(
        .value.depended_by = ((.value.depended_by // []) | unique_by(.service + "|" + .edge_type + "|" + .discovery_tier))
        | .value.depends_on = ((.value.depends_on // []) | unique_by(.service + "|" + .edge_type + "|" + .discovery_tier))
      )
  '
}

discover_service_graph() {
  if ! command -v jq >/dev/null 2>&1; then
    printf '{"cluster":"%s","generated_at":"%s","discovery_tiers":["t1"],"services":{}}\n' \
      "${K8S_CONTEXT:-unknown}" "$(_sg_utc_iso)"
    return 0
  fi

  local services='{}'
  local namespace
  for namespace in "$@"; do
    [[ -n "$namespace" ]] || continue
    local ns_map
    ns_map="$(_sg_discover_t1_namespace "$namespace")"
    services="$(printf '%s\n%s\n' "$services" "$ns_map" | jq -cs '.[0] * .[1]')"
  done

  services="$(_sg_add_reverse_edges "$services")"

  local graph_json
  graph_json="$(jq -cn \
    --arg cluster "${K8S_CONTEXT:-unknown}" \
    --arg generated_at "$(_sg_utc_iso)" \
    --argjson tiers "$(_sg_tiers_json)" \
    --argjson services "$services" \
    '{
      cluster: $cluster,
      generated_at: $generated_at,
      discovery_tiers: $tiers,
      services: $services
    }')"

  local relationship_summary
  if relationship_summary="$(_sg_relationship_knowledge_summary)"; then
    graph_json="$(printf '%s\n' "$graph_json" | jq \
      --argjson rel_summary "$relationship_summary" \
      '.relationship_knowledge_summary = $rel_summary')"
  fi

  printf '%s\n' "$graph_json"
}

_write_service_graph_locked() {
  local graph_json="$1"
  local tmp_file="${SERVICE_GRAPH_FILE}.tmp.$$"

  mkdir -p "${SERVICE_GRAPH_FILE%/*}"
  printf '%s\n' "$graph_json" >"$tmp_file"
  _sg_atomic_replace "$SERVICE_GRAPH_FILE" "$tmp_file"
}

write_service_graph() {
  local graph_json="$1"
  _sg_with_lock "$SERVICE_GRAPH_LOCK" _write_service_graph_locked "$graph_json"
}

read_service_graph() {
  if [[ -s "$SERVICE_GRAPH_FILE" ]]; then
    cat "$SERVICE_GRAPH_FILE"
    return 0
  fi
  printf '{"services":{}}\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf 'library script; source this file\n' >&2
fi
