#!/usr/bin/env bash

_cm_normalize_set() {
  local raw="${1:-}"
  [[ -z "$raw" ]] && {
    printf '\n'
    return 0
  }
  printf '%s\n' "$raw" \
    | tr '|, ' '\n\n\n' \
    | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' \
    | awk 'NF > 0 { print }' \
    | sort -u
}

_cm_set_size() {
  local normalized
  normalized="$(_cm_normalize_set "${1:-}")"
  [[ -z "$normalized" ]] && {
    printf '0\n'
    return 0
  }
  printf '%s\n' "$normalized" | awk 'NF > 0 { c++ } END { print c + 0 }'
}

_cm_intersection_count() {
  local set_a="${1:-}"
  local set_b="${2:-}"
  awk '
    $1 == "A" { a[$2] = 1; next }
    $1 == "B" { b[$2] = 1; next }
    END {
      c = 0
      for (k in a) {
        if (k in b) c++
      }
      print c + 0
    }
  ' <<EOF_IN
$(printf '%s\n' "$(_cm_normalize_set "$set_a")" | awk 'NF>0 {print "A\t"$0}')
$(printf '%s\n' "$(_cm_normalize_set "$set_b")" | awk 'NF>0 {print "B\t"$0}')
EOF_IN
}

jaccard() {
  local set_a="${1:-}"
  local set_b="${2:-}"

  awk '
    $1 == "A" { a[$2] = 1; next }
    $1 == "B" { b[$2] = 1; next }
    END {
      inter = 0
      uni = 0
      for (k in a) {
        uni++
        if (k in b) inter++
      }
      for (k in b) {
        if (!(k in a)) uni++
      }
      if (uni == 0) {
        printf "0.000\n"
      } else {
        printf "%.3f\n", inter / uni
      }
    }
  ' <<EOF_IN
$(printf '%s\n' "$(_cm_normalize_set "$set_a")" | awk 'NF>0 {print "A\t"$0}')
$(printf '%s\n' "$(_cm_normalize_set "$set_b")" | awk 'NF>0 {print "B\t"$0}')
EOF_IN
}

_cm_float_gt() {
  awk -v a="${1:-0}" -v b="${2:-0}" 'BEGIN { exit (a + 0 > b + 0 ? 0 : 1) }'
}

_cm_float_eq() {
  awk -v a="${1:-0}" -v b="${2:-0}" 'BEGIN { d = a - b; if (d < 0) d = -d; exit (d < 0.0001 ? 0 : 1) }'
}

_cm_to_epoch() {
  local raw="${1:-}"
  if [[ "$raw" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$raw"
    return 0
  fi

  if [[ "$raw" =~ ^[0-9]{8}T[0-9]{4}$ ]]; then
    if date -u -j -f "%Y%m%dT%H%M" "$raw" +%s >/dev/null 2>&1; then
      date -u -j -f "%Y%m%dT%H%M" "$raw" +%s
      return 0
    fi
    if date -u -d "$raw" +%s >/dev/null 2>&1; then
      date -u -d "$raw" +%s
      return 0
    fi
  fi

  if date -u -d "$raw" +%s >/dev/null 2>&1; then
    date -u -d "$raw" +%s
    return 0
  fi
  if date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$raw" +%s >/dev/null 2>&1; then
    date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$raw" +%s
    return 0
  fi

  printf '0\n'
}

_cm_minutes_since() {
  local ts="$(_cm_to_epoch "${1:-0}")"
  local now="$(_cm_to_epoch "${2:-$(date +%s)}")"
  if [[ "$ts" -le 0 || "$now" -le 0 || "$now" -lt "$ts" ]]; then
    printf '999999\n'
    return 0
  fi
  printf '%s\n' "$(((now - ts) / 60))"
}

_cm_recency_score() {
  local incident_last_seen_ts="${1:-0}"
  local now_ts="${2:-$(date +%s)}"
  local minutes
  minutes="$(_cm_minutes_since "$incident_last_seen_ts" "$now_ts")"
  awk -v mins="$minutes" 'BEGIN {
    v = 1 - (mins / 60.0)
    if (v < 0) v = 0
    if (v > 1) v = 1
    printf "%.3f\n", v
  }'
}

exact_match() {
  local hb_ns="${1:-}"
  local hb_category="${2:-}"
  local hb_workloads="${3:-}"
  local incident_ns="${4:-}"
  local incident_category="${5:-}"
  local incident_workloads="${6:-}"
  local incident_last_seen_ts="${7:-0}"
  local now_ts="${8:-$(date +%s)}"

  [[ "$hb_ns" == "$incident_ns" ]] || return 1
  [[ "$hb_category" == "$incident_category" ]] || return 1

  local minutes
  minutes="$(_cm_minutes_since "$incident_last_seen_ts" "$now_ts")"
  [[ "$minutes" -le 120 ]] || return 1

  local hb_sz incident_sz
  hb_sz="$(_cm_set_size "$hb_workloads")"
  incident_sz="$(_cm_set_size "$incident_workloads")"
  if [[ "$hb_sz" -gt 0 && "$incident_sz" -gt 0 ]]; then
    local overlap
    overlap="$(_cm_intersection_count "$hb_workloads" "$incident_workloads")"
    [[ "$overlap" -ge 1 ]] || return 1
  fi

  return 0
}

continuity_match() {
  local hb_ns="${1:-}"
  local hb_category="${2:-}"
  local hb_workloads="${3:-}"
  local hb_signals="${4:-}"
  local incident_ns="${5:-}"
  local incident_category="${6:-}"
  local incident_workloads="${7:-}"
  local incident_signals="${8:-}"
  local incident_last_seen_ts="${9:-0}"
  local now_ts="${10:-$(date +%s)}"

  [[ "$hb_ns" == "$incident_ns" ]] || return 1
  [[ "$hb_category" != "$incident_category" ]] || return 1

  local minutes
  minutes="$(_cm_minutes_since "$incident_last_seen_ts" "$now_ts")"
  [[ "$minutes" -le 60 ]] || return 1

  local wl_available=0
  local sk_available=0
  [[ "$(_cm_set_size "$hb_workloads")" -gt 0 && "$(_cm_set_size "$incident_workloads")" -gt 0 ]] && wl_available=1
  [[ "$(_cm_set_size "$hb_signals")" -gt 0 && "$(_cm_set_size "$incident_signals")" -gt 0 ]] && sk_available=1

  if [[ "$wl_available" -eq 0 && "$sk_available" -eq 0 ]]; then
    return 2
  fi

  local wl_ok=1
  local sk_ok=1

  if [[ "$wl_available" -eq 1 ]]; then
    local wl_j
    wl_j="$(jaccard "$hb_workloads" "$incident_workloads")"
    wl_ok=0
    awk -v val="$wl_j" 'BEGIN { exit (val + 0 >= 0.50 ? 0 : 1) }' && wl_ok=1 || true
  fi

  if [[ "$sk_available" -eq 1 ]]; then
    local sk_j
    sk_j="$(jaccard "$hb_signals" "$incident_signals")"
    local threshold="0.30"
    [[ "$wl_available" -eq 0 ]] && threshold="0.50"
    sk_ok=0
    awk -v val="$sk_j" -v thr="$threshold" 'BEGIN { exit (val + 0 >= thr + 0 ? 0 : 1) }' && sk_ok=1 || true
  fi

  if [[ "$wl_available" -eq 1 && "$sk_available" -eq 0 ]]; then
    local wl_j_raised
    wl_j_raised="$(jaccard "$hb_workloads" "$incident_workloads")"
    wl_ok=0
    awk -v val="$wl_j_raised" 'BEGIN { exit (val + 0 >= 0.70 ? 0 : 1) }' && wl_ok=1 || true
  fi

  [[ "$wl_ok" -eq 1 && "$sk_ok" -eq 1 ]]
}

_cm_continuity_score() {
  local hb_workloads="${1:-}"
  local hb_signals="${2:-}"
  local incident_workloads="${3:-}"
  local incident_signals="${4:-}"
  local incident_last_seen_ts="${5:-0}"
  local now_ts="${6:-$(date +%s)}"

  local wl_available=0
  local sk_available=0
  [[ "$(_cm_set_size "$hb_workloads")" -gt 0 && "$(_cm_set_size "$incident_workloads")" -gt 0 ]] && wl_available=1
  [[ "$(_cm_set_size "$hb_signals")" -gt 0 && "$(_cm_set_size "$incident_signals")" -gt 0 ]] && sk_available=1

  local wl_j="0"
  local sk_j="0"
  local recency
  recency="$(_cm_recency_score "$incident_last_seen_ts" "$now_ts")"

  [[ "$wl_available" -eq 1 ]] && wl_j="$(jaccard "$hb_workloads" "$incident_workloads")"
  [[ "$sk_available" -eq 1 ]] && sk_j="$(jaccard "$hb_signals" "$incident_signals")"

  if [[ "$wl_available" -eq 1 && "$sk_available" -eq 1 ]]; then
    awk -v wl="$wl_j" -v sk="$sk_j" -v rc="$recency" 'BEGIN { printf "%.3f\n", (wl*0.5) + (sk*0.3) + (rc*0.2) }'
    return 0
  fi
  if [[ "$wl_available" -eq 1 && "$sk_available" -eq 0 ]]; then
    awk -v wl="$wl_j" -v rc="$recency" 'BEGIN { printf "%.3f\n", (wl*0.7142857) + (rc*0.2857143) }'
    return 0
  fi
  if [[ "$wl_available" -eq 0 && "$sk_available" -eq 1 ]]; then
    awk -v sk="$sk_j" -v rc="$recency" 'BEGIN { printf "%.3f\n", (sk*0.6) + (rc*0.4) }'
    return 0
  fi
  printf '0.000\n'
}

route_heartbeat() {
  local hb_ns="${1:-}"
  local hb_category="${2:-}"
  local hb_workloads="${3:-}"
  local hb_signals="${4:-}"
  local now_ts="${5:-$(date +%s)}"
  local incidents_file="${6:-}"

  [[ -f "$incidents_file" ]] || {
    printf 'new\tno_state\tNEW\t0.000\n'
    return 0
  }

  local exact_file cont_file
  exact_file="$(mktemp)"
  cont_file="$(mktemp)"
  trap 'rm -f "$exact_file" "$cont_file"' RETURN

  local d=$'\x1f'
  while IFS="$d" read -r c1 c2 c3 c4 c5 c9 c12; do
    [[ -z "${c1:-}" ]] && continue
    [[ "$c1" == \#* ]] && continue

    if exact_match "$hb_ns" "$hb_category" "$hb_workloads" "$c2" "$c3" "$c12" "$c5" "$now_ts"; then
      printf '%s\x1f%s\x1f%s\x1f%s\x1f%s\n' "$c1" "$c5" "$c4" "$c12" "$c9" >>"$exact_file"
      continue
    fi

    if continuity_match "$hb_ns" "$hb_category" "$hb_workloads" "$hb_signals" "$c2" "$c3" "$c12" "$c9" "$c5" "$now_ts"; then
      local score
      score="$(_cm_continuity_score "$hb_workloads" "$hb_signals" "$c12" "$c9" "$c5" "$now_ts")"
      printf '%s\x1f%s\x1f%s\x1f%s\n' "$c1" "$score" "$c4" "$c5" >>"$cont_file"
    fi
  done < <(awk -F'\t' 'NR > 1 && $1 !~ /^#/ {printf "%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\n", $1, $2, $3, $4, $5, $9, $12}' "$incidents_file")

  local exact_count
  exact_count="$(awk 'NF>0 {c++} END {print c+0}' "$exact_file")"

  if [[ "$exact_count" -eq 1 ]]; then
    printf 'match\texact\t%s\t1.000\n' "$(awk -F'\x1f' 'NF>0 {print $1; exit}' "$exact_file")"
    return 0
  fi

  if [[ "$exact_count" -gt 1 ]]; then
    if [[ "$(_cm_set_size "$hb_workloads")" -gt 0 ]]; then
      local best_id=""
      local best_score="-1"
      local best_last_seen="0"
      local best_first_seen="0"
      while IFS="$d" read -r id last_seen first_seen workloads _signals; do
        [[ -z "$id" ]] && continue
        local score
        score="$(jaccard "$hb_workloads" "$workloads")"
        local last_seen_epoch first_seen_epoch
        last_seen_epoch="$(_cm_to_epoch "$last_seen")"
        first_seen_epoch="$(_cm_to_epoch "$first_seen")"

        if [[ -z "$best_id" ]] || _cm_float_gt "$score" "$best_score" \
          || (_cm_float_eq "$score" "$best_score" && [[ "$last_seen_epoch" -gt "$best_last_seen" ]]) \
          || (_cm_float_eq "$score" "$best_score" && [[ "$last_seen_epoch" -eq "$best_last_seen" ]] && [[ "$first_seen_epoch" -lt "$best_first_seen" ]]); then
          best_id="$id"
          best_score="$score"
          best_last_seen="$last_seen_epoch"
          best_first_seen="$first_seen_epoch"
        fi
      done <"$exact_file"
      printf 'match\texact_multi\t%s\t%s\n' "$best_id" "$best_score"
      return 0
    fi

    local sentinel_id=""
    local sentinel_last_seen="0"
    local sentinel_first_seen="0"
    while IFS="$d" read -r id last_seen first_seen workloads _signals; do
      [[ -z "$id" ]] && continue
      [[ "$id" == *":empty000" ]] || continue
      [[ "$(_cm_set_size "$workloads")" -eq 0 ]] || continue

      local last_seen_epoch first_seen_epoch
      last_seen_epoch="$(_cm_to_epoch "$last_seen")"
      first_seen_epoch="$(_cm_to_epoch "$first_seen")"

      if [[ -z "$sentinel_id" || "$last_seen_epoch" -gt "$sentinel_last_seen" || ("$last_seen_epoch" -eq "$sentinel_last_seen" && "$first_seen_epoch" -lt "$sentinel_first_seen") ]]; then
        sentinel_id="$id"
        sentinel_last_seen="$last_seen_epoch"
        sentinel_first_seen="$first_seen_epoch"
      fi
    done <"$exact_file"

    if [[ -n "$sentinel_id" ]]; then
      printf 'match\texact_empty_sentinel\t%s\t1.000\n' "$sentinel_id"
    else
      printf 'new\texact_ambiguous_empty\tNEW_SENTINEL\t0.000\n'
    fi
    return 0
  fi

  local cont_count
  cont_count="$(awk 'NF>0 {c++} END {print c+0}' "$cont_file")"
  if [[ "$cont_count" -gt 0 ]]; then
    local best_id=""
    local best_score="-1"
    local best_first_seen="0"
    while IFS="$d" read -r id score first_seen _last_seen; do
      [[ -z "$id" ]] && continue
      local first_seen_epoch
      first_seen_epoch="$(_cm_to_epoch "$first_seen")"
      if [[ -z "$best_id" ]] || _cm_float_gt "$score" "$best_score" \
        || (_cm_float_eq "$score" "$best_score" && [[ "$first_seen_epoch" -lt "$best_first_seen" ]]); then
        best_id="$id"
        best_score="$score"
        best_first_seen="$first_seen_epoch"
      fi
    done <"$cont_file"
    printf 'match\tcontinuity\t%s\t%s\n' "$best_id" "$best_score"
    return 0
  fi

  printf 'new\tno_match\tNEW\t0.000\n'
}

check_stale_resolve() {
  local last_seen_ts="${1:-0}"
  local last_nonempty_ts="${2:-0}"
  local current_ts="${3:-$(date +%s)}"
  local non_primary_streak="${4:-0}"
  local current_workloads="${5:-}"
  local incident_workloads="${6:-}"
  local heartbeat_state="${7:-incident}"

  if [[ "$heartbeat_state" == "healthy" ]]; then
    printf 'healthy_heartbeat\n'
    return 0
  fi

  local mins_seen mins_nonempty
  mins_seen="$(_cm_minutes_since "$last_seen_ts" "$current_ts")"
  mins_nonempty="$(_cm_minutes_since "$last_nonempty_ts" "$current_ts")"

  if [[ "$mins_seen" -gt 240 || "$mins_nonempty" -gt 240 ]]; then
    printf 'stale_timeout_forced\n'
    return 0
  fi

  if [[ "$mins_nonempty" -gt 120 ]]; then
    printf 'stale_timeout\n'
    return 0
  fi

  if [[ "$non_primary_streak" -ge 2 && "$(_cm_set_size "$current_workloads")" -gt 0 ]]; then
    local overlap
    overlap="$(_cm_intersection_count "$current_workloads" "$incident_workloads")"
    if [[ "$overlap" -eq 0 ]]; then
      printf 'stale_timeout_non_primary\n'
      return 0
    fi
  fi

  printf '\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf 'library script; source this file\n' >&2
fi
