#!/usr/bin/env bash

INCIDENT_MEMORY_FILE="${INCIDENT_MEMORY_FILE:-${INCIDENT_STATE_DIR:-/tmp/openclaw-state}/incident-memory.jsonl}"
INCIDENT_MEMORY_LOCK="${INCIDENT_MEMORY_LOCK:-${INCIDENT_MEMORY_FILE}.lock}"
INCIDENT_MEMORY_MAX_ENTRIES="${INCIDENT_MEMORY_MAX_ENTRIES:-500}"
INCIDENT_MEMORY_RETRIEVAL_DAYS="${INCIDENT_MEMORY_RETRIEVAL_DAYS:-90}"

_im_utc_date() {
  date -u +%Y-%m-%d
}

_im_days_ago() {
  local days="$1"
  date -u -v-"${days}"d +%Y-%m-%d 2>/dev/null \
    || date -u -d "${days} days ago" +%Y-%m-%d 2>/dev/null \
    || printf '1970-01-01\n'
}

_im_compact_ts_from_epoch() {
  local epoch="$1"
  date -u -r "$epoch" +%Y%m%dT%H%M 2>/dev/null \
    || date -u -d "@${epoch}" +%Y%m%dT%H%M 2>/dev/null \
    || date -u +%Y%m%dT%H%M
}

_im_first_seen_token() {
  local raw="${1:-}"
  if [[ -z "$raw" ]]; then
    date -u +%Y%m%dT%H%M
    return 0
  fi
  if [[ "$raw" =~ ^[0-9]{8}T[0-9]{4}$ ]]; then
    printf '%s\n' "$raw"
    return 0
  fi
  if [[ "$raw" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
    printf '%s\n' "${raw:0:13}"
    return 0
  fi
  if [[ "$raw" =~ ^[0-9]+$ ]]; then
    _im_compact_ts_from_epoch "$raw"
    return 0
  fi
  date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$raw" +%Y%m%dT%H%M 2>/dev/null \
    || date -u -d "$raw" +%Y%m%dT%H%M 2>/dev/null \
    || date -u +%Y%m%dT%H%M
}

_im_short_hash8() {
  local raw="$1"
  local compact
  compact="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-f0-9')"
  if [[ ${#compact} -ge 8 ]]; then
    printf '%s\n' "${compact:0:8}"
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 <<<"$raw" | awk '{print substr($1,1,8)}'
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum <<<"$raw" | awk '{print substr($1,1,8)}'
    return 0
  fi
  printf '00000000\n'
}

_im_default_evidence_fingerprint() {
  local triage_id="${TRIAGE_INCIDENT_ID:-}"
  if [[ "$triage_id" =~ :fp:([^:]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  if [[ "$triage_id" =~ :fp([a-zA-Z0-9]+): ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  printf 'unknown\n'
}

_im_parse_workloads_json() {
  local raw="${AFFECTED_WORKLOADS:-}"
  if [[ -z "$raw" ]] || ! command -v jq >/dev/null 2>&1; then
    printf '[]\n'
    return 0
  fi
  printf '%s\n' "$raw" \
    | tr ',|' '\n' \
    | sed '/^[[:space:]]*$/d' \
    | jq -R . \
    | jq -s 'unique'
}

_im_strip_instruction_tokens() {
  local text="$1"
  printf '%s\n' "$text" | grep -v -E '(You are|Ignore previous|System:|Assistant:|<\||\[INST\]|</s>)' || true
}

_im_sanitize_context_value() {
  local raw="$1"
  local stripped
  if declare -f _strip_instruction_tokens >/dev/null 2>&1; then
    stripped="$(_strip_instruction_tokens "$raw")"
  else
    stripped="$(_im_strip_instruction_tokens "$raw")"
  fi
  if [[ ${#stripped} -gt 200 ]]; then
    printf '%s\n' "${stripped:0:200}"
    return 0
  fi
  printf '%s\n' "$stripped"
}

_im_lock_run() {
  local lock_file="$1"
  shift
  mkdir -p "${lock_file%/*}"

  if declare -f _state_with_lock >/dev/null 2>&1; then
    _state_with_lock "$lock_file" "$@"
    return $?
  fi

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

  "$@"
}

_im_atomic_replace() {
  local target_file="$1"
  local tmp_file="$2"
  if declare -f _state_atomic_replace >/dev/null 2>&1; then
    _state_atomic_replace "$target_file" "$tmp_file"
    return $?
  fi
  mv -f "$tmp_file" "$target_file"
}

extract_incident_card() {
  local rca_json_raw="${1:-{}}"

  if ! command -v jq >/dev/null 2>&1; then
    printf '{}\n'
    return 1
  fi

  local rca_json
  rca_json="$(jq -c . 2>/dev/null <<<"$rca_json_raw" || true)"
  [[ -n "$rca_json" ]] || rca_json='{}'

  local cluster namespace service triage_id heuristic_category
  cluster="${CLUSTER:-${K8S_CONTEXT:-unknown}}"
  namespace="${NAMESPACE:-unknown}"
  service="${SERVICE:-unknown}"
  triage_id="${TRIAGE_INCIDENT_ID:-triage:unknown}"
  if [[ -n "${HEURISTIC_CATEGORY:-}" ]]; then
    heuristic_category="$HEURISTIC_CATEGORY"
  else
    heuristic_category="$(printf '%s\n' "$triage_id" | awk -F':' 'NF>=3 {print $3; exit}')"
  fi

  local category severity rca_confidence evidence_fingerprint
  category="$(jq -r '.canonical_category // .hypotheses[0].canonical_category // "unknown"' <<<"$rca_json")"
  severity="$(jq -r '.severity // "unknown"' <<<"$rca_json")"
  rca_confidence="$(jq -r '(.rca_confidence // .confidence // 0) | tonumber? // 0' <<<"$rca_json")"
  evidence_fingerprint="$(jq -r '.evidence_fingerprint // empty' <<<"$rca_json")"
  [[ -n "$category" && "$category" != "null" ]] || category="unknown"
  [[ -n "$severity" && "$severity" != "null" ]] || severity="unknown"
  if [[ -z "$evidence_fingerprint" || "$evidence_fingerprint" == "null" ]]; then
    evidence_fingerprint="$(_im_default_evidence_fingerprint)"
  fi

  local card_type
  card_type="$(jq -r '
    (.chain_metadata.stages_completed // []) as $s
    | if (($s | index("A") != null) and ($s | index("B") != null) and ($s | index("C") != null) and ($s | index("D") != null))
      then "full"
      else "partial"
      end
  ' 2>/dev/null <<<"$rca_json")"
  [[ -n "$card_type" ]] || card_type="partial"

  local first_seen_token evidence_hash8 card_id date workloads_json
  first_seen_token="$(_im_first_seen_token "${INCIDENT_FIRST_SEEN_TS:-${FIRST_SEEN_TS:-}}")"
  evidence_hash8="$(_im_short_hash8 "$evidence_fingerprint")"
  card_id="hb:${namespace}:${category}:${first_seen_token}:${evidence_hash8}"
  date="${INCIDENT_DATE:-$(_im_utc_date)}"
  workloads_json="$(_im_parse_workloads_json)"

  jq -cn \
    --argjson r "$rca_json" \
    --arg card_id "$card_id" \
    --arg triage_id "$triage_id" \
    --arg card_type "$card_type" \
    --arg namespace "$namespace" \
    --arg cluster "$cluster" \
    --arg service "$service" \
    --arg date "$date" \
    --arg category "$category" \
    --arg severity "$severity" \
    --arg evidence_fingerprint "$evidence_fingerprint" \
    --arg heuristic_category "$heuristic_category" \
    --argjson rca_confidence "$rca_confidence" \
    --argjson workloads "$workloads_json" '
      {
        card_id: $card_id,
        triage_incident_id: $triage_id,
        card_type: $card_type,
        namespace: $namespace,
        cluster: $cluster,
        service: $service,
        date: $date,
        category: $category,
        severity: $severity,
        rca_confidence: $rca_confidence,
        evidence_fingerprint: $evidence_fingerprint
      }
      + (if $heuristic_category != "" then {heuristic_category: $heuristic_category} else {} end)
      + (if ($workloads | length) > 0 then {affected_workloads: $workloads} else {} end)
      + (if $card_type == "full" then
          {
            root_cause_summary: ($r.root_cause // $r.summary // ""),
            trigger: ($r.trigger // $r.chain_metadata.causal_chain.trigger_event // ""),
            propagation_path: ($r.propagation_path // $r.chain_metadata.causal_chain.propagation // []),
            fix_applied: ($r.fix_applied // $r.remediation // ""),
            permanent_fix_pr: ($r.permanent_fix_pr // ""),
            rca_model: ($r.rca_model // $r.model // ""),
            rca_prompt_version: ($r.rca_prompt_version // (env.RCA_PROMPT_VERSION // "")),
            tags: (
              if ($r.tags | type? ) == "array" then $r.tags
              elif (($r.hypotheses // []) | length) > 0 then [($r.hypotheses[]?.hypothesis_id // empty)] | map(select(. != ""))
              else []
              end
            ),
            lessons: (if (($r.lessons | type?) == "array") then $r.lessons else [] end)
          }
          + (if ($r.time_to_detect_min // null) != null then {time_to_detect_min: $r.time_to_detect_min} else {} end)
          + (if ($r.time_to_mitigate_min // null) != null then {time_to_mitigate_min: $r.time_to_mitigate_min} else {} end)
        else {} end)
      | with_entries(select(.value != null and .value != "" and .value != []))
    '
}

_im_apply_retention_policy() {
  local cards_json="$1"
  local cutoff_low cutoff_medium cutoff_high
  cutoff_low="$(_im_days_ago 90)"
  cutoff_medium="$(_im_days_ago 180)"
  cutoff_high="$(_im_days_ago 365)"

  printf '%s\n' "$cards_json" | jq -c \
    --arg cutoff_low "$cutoff_low" \
    --arg cutoff_medium "$cutoff_medium" \
    --arg cutoff_high "$cutoff_high" '
      map(
        ((.severity // "low") | ascii_downcase) as $sev
        | if ($sev == "critical" or $sev == "high") then
            select((.date // "1970-01-01") >= $cutoff_high)
          elif $sev == "medium" then
            select((.date // "1970-01-01") >= $cutoff_medium)
          else
            select((.date // "1970-01-01") >= $cutoff_low)
          end
      )
    '
}

_im_enforce_cap() {
  local cards_json="$1"
  printf '%s\n' "$cards_json" | jq -c --argjson max "$INCIDENT_MEMORY_MAX_ENTRIES" '
    if length <= $max then
      .
    else
      # Evict low-severity oldest first, then medium, then high/critical.
      sort_by(
        (if (.severity // "low") == "low" then 0
         elif (.severity // "low") == "medium" then 1
         elif (.severity // "low") == "high" then 2
         elif (.severity // "low") == "critical" then 3
         else 0 end),
        (.date // "1970-01-01"),
        (.card_id // "")
      )
      | .[-$max:]
    end
  '
}

_memory_write_locked() {
  local card_json="$1"

  mkdir -p "${INCIDENT_MEMORY_FILE%/*}"
  [[ -f "$INCIDENT_MEMORY_FILE" ]] || : >"$INCIDENT_MEMORY_FILE"

  local existing card_id merged tmp_file
  existing="$(jq -s '.' "$INCIDENT_MEMORY_FILE" 2>/dev/null || printf '[]\n')"
  card_id="$(printf '%s\n' "$card_json" | jq -r '.card_id // ""')"

  merged="$(jq -cn --argjson cards "$existing" --argjson card "$card_json" --arg card_id "$card_id" '
    ($cards | map(select((.card_id // "") != $card_id))) + [$card]
  ')"
  merged="$(_im_apply_retention_policy "$merged")"
  merged="$(_im_enforce_cap "$merged")"

  tmp_file="${INCIDENT_MEMORY_FILE}.tmp.$$"
  printf '%s\n' "$merged" | jq -c '.[]' >"$tmp_file"
  _im_atomic_replace "$INCIDENT_MEMORY_FILE" "$tmp_file"
}

memory_write_card() {
  local raw_card_json="$1"

  if ! command -v jq >/dev/null 2>&1; then
    printf 'WARN: jq missing; cannot write incident card\n' >&2
    return 1
  fi

  local card_json
  card_json="$(printf '%s\n' "$raw_card_json" | jq -c . 2>/dev/null || true)"
  [[ -n "$card_json" ]] || return 1

  if declare -f _rca_prompt_scrub >/dev/null 2>&1; then
    card_json="$(_rca_prompt_scrub "$card_json")"
    card_json="$(printf '%s\n' "$card_json" | jq -c . 2>/dev/null || true)"
  fi

  local card_id
  card_id="$(printf '%s\n' "$card_json" | jq -r '.card_id // ""')"
  [[ -n "$card_id" ]] || return 1

  _im_lock_run "$INCIDENT_MEMORY_LOCK" _memory_write_locked "$card_json"
}

memory_lookup_broad() {
  local cluster="$1"
  local namespace="$2"
  local service="$3"

  [[ -s "$INCIDENT_MEMORY_FILE" ]] || {
    printf '[]\n'
    return 0
  }
  if ! command -v jq >/dev/null 2>&1; then
    printf '[]\n'
    return 0
  fi

  local cutoff
  cutoff="$(_im_days_ago "$INCIDENT_MEMORY_RETRIEVAL_DAYS")"

  jq -s \
    --arg cluster "$cluster" \
    --arg namespace "$namespace" \
    --arg service "$service" \
    --arg cutoff "$cutoff" '
      map(
        select(
          (.cluster // "") == $cluster
          and (.namespace // "") == $namespace
          and (.service // "") == $service
          and ((.date // "1970-01-01") >= $cutoff)
        )
      )
      | sort_by(.date // "1970-01-01")
      | reverse
      | .[:5]
    ' "$INCIDENT_MEMORY_FILE" 2>/dev/null || printf '[]\n'
}

memory_lookup_precise() {
  local cluster="$1"
  local namespace="$2"
  local service="$3"
  local category="$4"

  [[ -s "$INCIDENT_MEMORY_FILE" ]] || {
    printf '[]\n'
    return 0
  }
  if ! command -v jq >/dev/null 2>&1; then
    printf '[]\n'
    return 0
  fi

  local cutoff
  cutoff="$(_im_days_ago "$INCIDENT_MEMORY_RETRIEVAL_DAYS")"

  jq -s \
    --arg cluster "$cluster" \
    --arg namespace "$namespace" \
    --arg service "$service" \
    --arg category "$category" \
    --arg cutoff "$cutoff" '
      map(
        select(
          (.cluster // "") == $cluster
          and (.namespace // "") == $namespace
          and (.service // "") == $service
          and (.category // "") == $category
          and ((.date // "1970-01-01") >= $cutoff)
        )
      )
      | sort_by(.date // "1970-01-01")
      | reverse
      | .[:5]
    ' "$INCIDENT_MEMORY_FILE" 2>/dev/null || printf '[]\n'
}

format_memory_context() {
  local cards_json
  cards_json="$(cat)"

  if ! command -v jq >/dev/null 2>&1; then
    printf 'No past incidents in memory.\n'
    return 0
  fi

  local count
  count="$(printf '%s\n' "$cards_json" | jq 'length' 2>/dev/null || printf '0\n')"
  if [[ "$count" -eq 0 ]]; then
    printf 'Past incidents (last 90d):\n  (none)\n'
    return 0
  fi

  printf 'Past incidents (last 90d):\n'
  while IFS=$'\t' read -r date category severity root fix pr; do
    local clean_date clean_category clean_severity clean_root clean_fix clean_pr
    clean_date="$(_im_sanitize_context_value "$date")"
    clean_category="$(_im_sanitize_context_value "$category")"
    clean_severity="$(_im_sanitize_context_value "$severity")"
    clean_root="$(_im_sanitize_context_value "$root")"
    clean_fix="$(_im_sanitize_context_value "$fix")"
    clean_pr="$(_im_sanitize_context_value "$pr")"

    local line="  - ${clean_date}: ${clean_category} (${clean_severity}) - ${clean_root}"
    if [[ -n "$clean_fix" ]]; then
      line+=" (fix: ${clean_fix})"
    fi
    if [[ -n "$clean_pr" ]]; then
      line+=" (PR ${clean_pr})"
    fi
    printf '%s\n' "$line"
  done < <(
    printf '%s\n' "$cards_json" | jq -r '
      .[]
      | [
          (.date // "unknown"),
          (.category // "unknown"),
          (.severity // "unknown"),
          (.root_cause_summary // "unknown"),
          (.fix_applied // ""),
          (.permanent_fix_pr // "")
        ]
      | @tsv
    '
  )
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf 'library script; source this file\n' >&2
fi
