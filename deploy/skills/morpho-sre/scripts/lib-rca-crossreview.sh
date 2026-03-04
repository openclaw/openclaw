#!/usr/bin/env bash

_cr_norm_set_from_json_array() {
  local json_array="${1:-[]}"
  if ! command -v jq >/dev/null 2>&1; then
    printf '\n'
    return 0
  fi
  printf '%s\n' "$json_array" | jq -r '.[]? // empty' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' | awk 'NF > 0 {print}' | sort -u
}

_cr_jaccard_from_arrays() {
  local arr_a="${1:-[]}"
  local arr_b="${2:-[]}"
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
      if (uni == 0) print "0.000";
      else printf "%.3f\n", inter / uni;
    }
  ' <<EOF_IN
$(printf '%s\n' "$(_cr_norm_set_from_json_array "$arr_a")" | awk 'NF>0 {print "A\t"$0}')
$(printf '%s\n' "$(_cr_norm_set_from_json_array "$arr_b")" | awk 'NF>0 {print "B\t"$0}')
EOF_IN
}

_cr_overlap_count_from_arrays() {
  local arr_a="${1:-[]}"
  local arr_b="${2:-[]}"
  awk '
    $1 == "A" { a[$2] = 1; next }
    $1 == "B" { b[$2] = 1; next }
    END {
      c = 0
      for (k in a) if (k in b) c++
      print c + 0
    }
  ' <<EOF_IN
$(printf '%s\n' "$(_cr_norm_set_from_json_array "$arr_a")" | awk 'NF>0 {print "A\t"$0}')
$(printf '%s\n' "$(_cr_norm_set_from_json_array "$arr_b")" | awk 'NF>0 {print "B\t"$0}')
EOF_IN
}

_cr_description_overlap() {
  local d1="${1:-}"
  local d2="${2:-}"
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
      if (uni == 0) print "0.000";
      else printf "%.3f\n", inter / uni;
    }
  ' <<EOF_IN
$(printf '%s\n' "$d1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '\n' | awk 'NF>0 {print "A\t"$0}')
$(printf '%s\n' "$d2" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '\n' | awk 'NF>0 {print "B\t"$0}')
EOF_IN
}

check_convergence() {
  local rca_a="${1:-}"
  local rca_b="${2:-}"
  local round="${3:-0}"

  if ! command -v jq >/dev/null 2>&1; then
    return 1
  fi

  local cat_a cat_b id_a id_b agree_a agree_b ev_a ev_b desc_a desc_b
  cat_a="$(printf '%s\n' "$rca_a" | jq -r '.canonical_category // .hypotheses[0].canonical_category // "unknown"')"
  cat_b="$(printf '%s\n' "$rca_b" | jq -r '.canonical_category // .hypotheses[0].canonical_category // "unknown"')"
  id_a="$(printf '%s\n' "$rca_a" | jq -r '.hypotheses[0].hypothesis_id // "unknown:insufficient_evidence"')"
  id_b="$(printf '%s\n' "$rca_b" | jq -r '.hypotheses[0].hypothesis_id // "unknown:insufficient_evidence"')"
  agree_a="$(printf '%s\n' "$rca_a" | jq -r '.agree_with_peer // false')"
  agree_b="$(printf '%s\n' "$rca_b" | jq -r '.agree_with_peer // false')"
  ev_a="$(printf '%s\n' "$rca_a" | jq -c '.hypotheses[0].evidence_keys // []')"
  ev_b="$(printf '%s\n' "$rca_b" | jq -c '.hypotheses[0].evidence_keys // []')"
  desc_a="$(printf '%s\n' "$rca_a" | jq -r '.hypotheses[0].description // ""')"
  desc_b="$(printf '%s\n' "$rca_b" | jq -r '.hypotheses[0].description // ""')"

  [[ "$cat_a" == "$cat_b" ]] || return 1
  [[ "$id_a" == "$id_b" ]] || return 1

  if [[ "$id_a" == *":other" && "$id_b" == *":other" ]]; then
    local desc_overlap
    desc_overlap="$(_cr_description_overlap "$desc_a" "$desc_b")"
    awk -v v="$desc_overlap" 'BEGIN { exit (v + 0 > 0.80 ? 0 : 1) }' || return 1
  fi

  local score overlap
  score="$(_cr_jaccard_from_arrays "$ev_a" "$ev_b")"
  overlap="$(_cr_overlap_count_from_arrays "$ev_a" "$ev_b")"
  awk -v s="$score" -v o="$overlap" 'BEGIN { exit (s + 0 >= 0.60 && o + 0 >= 2 ? 0 : 1) }' || return 1

  if [[ "$round" -ge 1 ]]; then
    [[ "$agree_a" == "true" && "$agree_b" == "true" ]] || return 1
  fi

  printf 'converged\t%s\t%s\n' "$score" "$overlap"
  return 0
}

merge_rcas() {
  local rca_a="${1:-}"
  local rca_b="${2:-}"

  if ! command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$rca_a"
    return 0
  fi

  local ev_a ev_b len_a len_b picked avg_conf score
  ev_a="$(printf '%s\n' "$rca_a" | jq -c '.hypotheses[0].evidence_keys // []')"
  ev_b="$(printf '%s\n' "$rca_b" | jq -c '.hypotheses[0].evidence_keys // []')"
  len_a="$(printf '%s\n' "$ev_a" | jq 'length')"
  len_b="$(printf '%s\n' "$ev_b" | jq 'length')"
  avg_conf="$(printf '%s\n%s\n' "$rca_a" "$rca_b" | jq -s '(((.[0].hypotheses[0].confidence // 0) + (.[1].hypotheses[0].confidence // 0)) / 2)')"
  score="$(_cr_jaccard_from_arrays "$ev_a" "$ev_b")"

  if [[ "$len_a" -ge "$len_b" ]]; then
    picked="$rca_a"
  else
    picked="$rca_b"
  fi

  printf '%s\n' "$picked" | jq -c --argjson avg "$avg_conf" --arg score "$score" '
    .merged_confidence = ($avg|tonumber)
    | .agreement_score = ($score|tonumber)
    | .degradation_note = null
  '
}

run_cross_review() {
  local round="${1:-0}"
  local rca_a="${2:-}"
  local rca_b="${3:-}"
  local evidence="${4:-}"
  local max_rounds="${5:-2}"

  if ! [[ "$max_rounds" =~ ^[0-9]+$ ]]; then
    max_rounds=2
  fi
  if (( max_rounds < 0 )); then
    max_rounds=2
  fi

  if [[ -z "$rca_a" && -z "$rca_b" ]]; then
    printf '{"mode":"heuristic","degradation_note":"Both LLM providers unavailable — heuristic fallback"}\n'
    return 0
  fi

  if [[ -n "$rca_a" && -z "$rca_b" ]]; then
    if command -v jq >/dev/null 2>&1; then
      printf '%s\n' "$rca_a" | jq -c '.degradation_note = "Claude unavailable — Codex-only RCA"'
    else
      printf '%s\n' "$rca_a"
    fi
    return 0
  fi

  if [[ -z "$rca_a" && -n "$rca_b" ]]; then
    if command -v jq >/dev/null 2>&1; then
      printf '%s\n' "$rca_b" | jq -c '.degradation_note = "Codex unavailable — Claude-only RCA"'
    else
      printf '%s\n' "$rca_b"
    fi
    return 0
  fi

  if check_convergence "$rca_a" "$rca_b" "$round" >/dev/null; then
    merge_rcas "$rca_a" "$rca_b"
    return 0
  fi

  if [[ "$round" -ge "$max_rounds" ]]; then
    if command -v jq >/dev/null 2>&1; then
      printf '%s\n' "$rca_a" | jq -c --arg max_rounds "$max_rounds" '
        .merged_confidence = ((.hypotheses[0].confidence // 0) * 0.8)
        | .agreement_score = 0
        | .degradation_note = ("Models did not converge after " + $max_rounds + " review rounds — Codex-primary report, low confidence")
      '
    else
      printf '%s\n' "$rca_a"
    fi
    return 0
  fi

  if declare -F crossreview_model_a >/dev/null 2>&1 && declare -F crossreview_model_b >/dev/null 2>&1; then
    local next_a next_b
    next_a="$(crossreview_model_a "$evidence" "$rca_b" "$rca_a" "$round")"
    next_b="$(crossreview_model_b "$evidence" "$rca_a" "$rca_b" "$round")"
    if command -v jq >/dev/null 2>&1; then
      jq -cn --argjson a "$next_a" --argjson b "$next_b" '{converged:false,next_a:$a,next_b:$b}'
    else
      printf '%s\n' "$next_a"
      printf '%s\n' "$next_b"
    fi
    return 0
  fi

  if command -v jq >/dev/null 2>&1; then
    jq -cn --argjson a "$rca_a" --argjson b "$rca_b" '{converged:false,next_a:$a,next_b:$b}'
  else
    printf '%s\n' "$rca_a"
    printf '%s\n' "$rca_b"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf 'library script; source this file\n' >&2
fi
