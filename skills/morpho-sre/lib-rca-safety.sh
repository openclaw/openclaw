#!/usr/bin/env bash

RCA_SAFETY_DIR="${RCA_SAFETY_DIR:-${INCIDENT_STATE_DIR:-/tmp/openclaw-state}}"
RCA_CONVERGENCE_FILE="${RCA_CONVERGENCE_FILE:-${RCA_SAFETY_DIR%/}/rca-convergence-stats.tsv}"
RCA_MODE_STATE_FILE="${RCA_MODE_STATE_FILE:-${RCA_SAFETY_DIR%/}/rca-mode-state.tsv}"
RCA_SAFETY_LOCK_FILE="${RCA_SAFETY_LOCK_FILE:-${RCA_SAFETY_DIR%/}/rca-safety.lock}"

_rca_safety_with_lock() {
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

  "$@"
}

_rca_safety_init_locked() {
  mkdir -p "$RCA_SAFETY_DIR"

  if [[ ! -f "$RCA_CONVERGENCE_FILE" ]]; then
    printf '#v1\tts\toutcome\n' >"$RCA_CONVERGENCE_FILE"
  fi

  if [[ ! -f "$RCA_MODE_STATE_FILE" ]]; then
    printf '#v1\tstate\tupdated_ts\tlast_probe_ts\n' >"$RCA_MODE_STATE_FILE"
    printf 'row\tnormal\t0\t0\n' >>"$RCA_MODE_STATE_FILE"
  fi
}

rca_safety_init() {
  _rca_safety_with_lock "$RCA_SAFETY_LOCK_FILE" _rca_safety_init_locked
}

_rca_safety_now() {
  date +%s
}

rca_safety_record_outcome() {
  local ts="${1:-$(_rca_safety_now)}"
  local outcome="${2:-}"
  [[ "$outcome" == "converged" || "$outcome" == "not_converged" ]] || return 1

  rca_safety_init
  _rca_safety_with_lock "$RCA_SAFETY_LOCK_FILE" _rca_safety_append_outcome_locked "$ts" "$outcome"
}

_rca_safety_append_outcome_locked() {
  local ts="$1"
  local outcome="$2"
  printf 'row\t%s\t%s\n' "$ts" "$outcome" >>"$RCA_CONVERGENCE_FILE"
}

_rca_safety_rates_for_window() {
  local now_ts="$1"
  local window_seconds="$2"
  local cutoff=$((now_ts - window_seconds))

  awk -F'\t' -v cutoff="$cutoff" '
    NR == 1 { next }
    $1 != "row" { next }
    $2 + 0 >= cutoff {
      total++
      if ($3 == "not_converged") bad++
    }
    END {
      rate = 0
      if (total > 0) rate = (bad * 100.0) / total
      printf "%.3f\t%d\n", rate, total
    }
  ' "$RCA_CONVERGENCE_FILE"
}

rca_safety_compute_rates() {
  local now_ts="${1:-$(_rca_safety_now)}"
  rca_safety_init

  local r7 s7 r14 s14
  read -r r7 s7 < <(_rca_safety_rates_for_window "$now_ts" 604800)
  read -r r14 s14 < <(_rca_safety_rates_for_window "$now_ts" 1209600)

  printf 'rate_7d\t%s\n' "$r7"
  printf 'samples_7d\t%s\n' "$s7"
  printf 'rate_14d\t%s\n' "$r14"
  printf 'samples_14d\t%s\n' "$s14"
}

_rca_safety_read_mode_row() {
  awk -F'\t' 'NR==2 {print $2"\t"$3"\t"$4}' "$RCA_MODE_STATE_FILE"
}

_rca_safety_write_mode_row() {
  local state="$1"
  local updated_ts="$2"
  local last_probe_ts="$3"

  local tmp="${RCA_MODE_STATE_FILE}.tmp.$$"
  printf '#v1\tstate\tupdated_ts\tlast_probe_ts\n' >"$tmp"
  printf 'row\t%s\t%s\t%s\n' "$state" "$updated_ts" "$last_probe_ts" >>"$tmp"
  mv -f "$tmp" "$RCA_MODE_STATE_FILE"
}

rca_safety_update_state() {
  local now_ts="${1:-$(_rca_safety_now)}"
  rca_safety_init

  _rca_safety_with_lock "$RCA_SAFETY_LOCK_FILE" _rca_safety_update_state_locked "$now_ts"
}

_rca_safety_update_state_locked() {
  local now_ts="$1"

  local mode_row current_state updated_ts last_probe_ts
  mode_row="$(_rca_safety_read_mode_row)"
  current_state="$(printf '%s\n' "$mode_row" | awk -F'\t' '{print $1}')"
  updated_ts="$(printf '%s\n' "$mode_row" | awk -F'\t' '{print $2}')"
  last_probe_ts="$(printf '%s\n' "$mode_row" | awk -F'\t' '{print $3}')"

  [[ -z "$current_state" ]] && current_state="normal"
  [[ -z "$updated_ts" ]] && updated_ts=0
  [[ -z "$last_probe_ts" ]] && last_probe_ts=0

  local r7 s7 r14 s14
  read -r r7 s7 < <(_rca_safety_rates_for_window "$now_ts" 604800)
  read -r r14 s14 < <(_rca_safety_rates_for_window "$now_ts" 1209600)

  local new_state="$current_state"
  local transition="none"

  if [[ "$current_state" == "normal" ]]; then
    if awk -v samples="$s7" -v rate="$r7" 'BEGIN { exit (samples >= 10 && rate > 30 ? 0 : 1) }'; then
      new_state="downgraded"
      transition="enter_downgrade"
    fi
  else
    if awk -v samples="$s14" -v rate="$r14" 'BEGIN { exit (samples < 10 || (samples >= 10 && rate < 15) ? 0 : 1) }'; then
      new_state="normal"
      transition="exit_downgrade"
    fi
  fi

  if [[ "$new_state" != "$current_state" ]]; then
    _rca_safety_write_mode_row "$new_state" "$now_ts" "$last_probe_ts"
  fi

  printf 'state\t%s\n' "$new_state"
  printf 'transition\t%s\n' "$transition"
  printf 'rate_7d\t%s\n' "$r7"
  printf 'samples_7d\t%s\n' "$s7"
  printf 'rate_14d\t%s\n' "$r14"
  printf 'samples_14d\t%s\n' "$s14"
}

rca_safety_effective_mode() {
  local configured_mode="${1:-single}"
  local severity="${2:-medium}"
  local now_ts="${3:-$(_rca_safety_now)}"

  rca_safety_init

  if [[ "$configured_mode" != "dual" ]]; then
    printf '%s\n' "$configured_mode"
    return 0
  fi

  local state
  state="$(rca_safety_update_state "$now_ts" | awk -F'\t' '$1=="state" {print $2; exit}')"

  if [[ "$state" != "downgraded" ]]; then
    printf 'dual\n'
    return 0
  fi

  local mode_row last_probe_ts
  mode_row="$(_rca_safety_read_mode_row)"
  last_probe_ts="$(printf '%s\n' "$mode_row" | awk -F'\t' '{print $3}')"
  [[ -z "$last_probe_ts" ]] && last_probe_ts=0

  case "$(printf '%s' "$severity" | tr '[:upper:]' '[:lower:]')" in
    medium|high|critical)
      if [[ $((now_ts - last_probe_ts)) -ge 86400 ]]; then
        _rca_safety_with_lock "$RCA_SAFETY_LOCK_FILE" _rca_safety_mark_probe_locked "$now_ts"
        printf 'dual_probe\n'
        return 0
      fi
      ;;
  esac

  printf 'single\n'
}

_rca_safety_mark_probe_locked() {
  local now_ts="$1"
  local mode_row state updated_ts
  mode_row="$(_rca_safety_read_mode_row)"
  state="$(printf '%s\n' "$mode_row" | awk -F'\t' '{print $1}')"
  updated_ts="$(printf '%s\n' "$mode_row" | awk -F'\t' '{print $2}')"
  [[ -z "$state" ]] && state="downgraded"
  [[ -z "$updated_ts" ]] && updated_ts="$now_ts"
  _rca_safety_write_mode_row "$state" "$updated_ts" "$now_ts"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  rca_safety_init
  rca_safety_compute_rates
fi
