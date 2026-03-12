#!/usr/bin/env bash

# shellcheck disable=SC2034
readonly -a STATE_FILE_COLUMNS=(
  incident_id
  namespace
  primary_category
  first_seen_ts
  last_seen_ts
  last_nonempty_ts
  rca_version
  evidence_fingerprint
  evidence_signal_keys
  linear_ticket_id
  slack_thread_ts
  affected_workloads
  category_drift_log
  slack_post_status
  slack_post_attempts
  linear_post_status
  linear_post_attempts
  linear_reservation
  bs_alias
  last_primary_ts
  non_primary_streak
)

readonly -a STATE_RESOLVED_EXTRA_COLUMNS=(resolution_reason resolved_ts)
readonly STATE_FILE_SCHEMA_VERSION="v1"
readonly STATE_FILE_RESOLVED_SCHEMA_VERSION="v1-resolved"
readonly STATE_VALID_ATOMIC_RE='^[A-Za-z0-9_:.][A-Za-z0-9_:.-]*$'
readonly STATE_VALID_FIELD_RE='^[A-Za-z0-9_:.|,-]*$'

state_default_file() {
  local state_dir="${INCIDENT_STATE_DIR:-/tmp/openclaw-state}"
  printf '%s\n' "${STATE_FILE_PATH:-${state_dir%/}/active-incidents.tsv}"
}

state_default_archive_file() {
  local state_file
  state_file="${1:-$(state_default_file)}"
  printf '%s\n' "${STATE_ARCHIVE_FILE:-${state_file%/*}/resolved-incidents.tsv}"
}

state_validate_atomic() {
  local value="${1:-}"
  [[ -z "$value" ]] && return 0
  [[ "$value" =~ $STATE_VALID_ATOMIC_RE ]]
}

_state_validate_field() {
  local value="${1:-}"
  [[ -z "$value" ]] && return 0
  [[ "$value" =~ $STATE_VALID_FIELD_RE ]]
}

_state_join_tabs() {
  local IFS=$'\t'
  printf '%s' "$*"
}

_state_active_header() {
  local joined
  joined="$(_state_join_tabs "${STATE_FILE_COLUMNS[@]}")"
  printf '#%s\t%s\n' "$STATE_FILE_SCHEMA_VERSION" "$joined"
}

_state_resolved_header() {
  local cols=()
  cols=("${STATE_FILE_COLUMNS[@]}" "${STATE_RESOLVED_EXTRA_COLUMNS[@]}")
  printf '#%s\t%s\n' "$STATE_FILE_RESOLVED_SCHEMA_VERSION" "$(_state_join_tabs "${cols[@]}")"
}

_state_now_epoch() {
  date +%s
}

_state_utc_stamp() {
  date -u +%Y%m%dT%H%M%SZ
}

_state_fsync_path() {
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

_state_fsync_dir() {
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

_state_atomic_replace() {
  local target_file="$1"
  local tmp_file="$2"
  _state_fsync_path "$tmp_file"
  mv -f "$tmp_file" "$target_file"
  _state_fsync_dir "${target_file%/*}"
}

_state_with_lock() {
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
      printf 'state lock timeout: %s\n' "$lock_file" >&2
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

_state_quarantine_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local quarantined="${file}.corrupt.$(_state_utc_stamp)"
  mv -f "$file" "$quarantined"
  printf 'quarantined\t%s\n' "$quarantined" >&2
}

_state_header_valid() {
  local file="$1"
  local expected_header="$2"
  [[ -s "$file" ]] || return 1
  local first_line
  first_line="$(head -n 1 "$file" 2>/dev/null || true)"
  [[ "$first_line" == "$expected_header" ]]
}

_state_write_header_only() {
  local file="$1"
  local header="$2"
  mkdir -p "${file%/*}"
  local tmp_file="${file}.tmp.$$"
  printf '%s\n' "$header" >"$tmp_file"
  _state_atomic_replace "$file" "$tmp_file"
}

_state_init_locked() {
  local state_file="$1"
  local expected_header
  expected_header="$(_state_active_header)"

  if _state_header_valid "$state_file" "$expected_header"; then
    return 0
  fi

  if [[ -e "$state_file" ]]; then
    _state_quarantine_file "$state_file"
  fi
  _state_write_header_only "$state_file" "$expected_header"
}

_state_init_archive_locked() {
  local archive_file="$1"
  local expected_header
  expected_header="$(_state_resolved_header)"

  if _state_header_valid "$archive_file" "$expected_header"; then
    return 0
  fi

  if [[ -e "$archive_file" ]]; then
    _state_quarantine_file "$archive_file"
  fi
  _state_write_header_only "$archive_file" "$expected_header"
}

state_init() {
  local state_file
  state_file="${1:-$(state_default_file)}"
  _state_with_lock "${state_file}.lock" _state_init_locked "$state_file"
}

_state_archive_init() {
  local archive_file="$1"
  _state_with_lock "${archive_file}.lock" _state_init_archive_locked "$archive_file"
}

state_read_all() {
  local state_file
  state_file="${1:-$(state_default_file)}"
  state_init "$state_file" || return 1
  awk 'NR > 1 && NF > 0 { print }' "$state_file"
}

state_read_incident() {
  local incident_id="$1"
  local state_file
  state_file="${2:-$(state_default_file)}"
  state_init "$state_file" || return 1
  awk -F'\t' -v id="$incident_id" 'NR > 1 && $1 == id { print; found=1; exit } END { if (!found) exit 1 }' "$state_file"
}

_state_validate_pipe_atoms() {
  local field="${1:-}"
  [[ -z "$field" ]] && return 0
  local item
  local old_ifs="$IFS"
  IFS='|'
  for item in $field; do
    [[ -z "$item" ]] && continue
    state_validate_atomic "$item" || return 1
  done
  IFS="$old_ifs"
}

_state_validate_comma_atoms() {
  local field="${1:-}"
  [[ -z "$field" ]] && return 0
  local item
  local old_ifs="$IFS"
  IFS=','
  for item in $field; do
    [[ -z "$item" ]] && continue
    state_validate_atomic "$item" || return 1
  done
  IFS="$old_ifs"
}

_state_validate_status() {
  local status="${1:-}"
  [[ -z "$status" ]] && return 0
  case "$status" in
    pending|sent|failed_retryable|failed_terminal) return 0 ;;
    *) return 1 ;;
  esac
}

_state_validate_uint() {
  local value="${1:-}"
  [[ -z "$value" ]] && return 0
  [[ "$value" =~ ^[0-9]+$ ]]
}

_state_validate_row() {
  local row="$1"
  [[ "$row" != *$'\n'* ]] || return 1

  printf '%s\n' "$row" | awk -F'\t' \
    -v expected="${#STATE_FILE_COLUMNS[@]}" \
    -v field_re="$STATE_VALID_FIELD_RE" \
    -v atomic_re="$STATE_VALID_ATOMIC_RE" '
      function field_ok(v) { return (v == "" || v ~ field_re) }
      function atomic_ok(v) { return (v == "" || v ~ atomic_re) }
      function status_ok(v) {
        return (v == "" || v == "pending" || v == "sent" || v == "failed_retryable" || v == "failed_terminal")
      }
      function uint_ok(v) { return (v == "" || v ~ /^[0-9]+$/) }
      function split_atomic_ok(v, sep, i, n, arr) {
        if (v == "") return 1
        n = split(v, arr, sep)
        for (i = 1; i <= n; i++) {
          if (arr[i] == "") continue
          if (!atomic_ok(arr[i])) return 0
        }
        return 1
      }
      {
        if (NF != expected) exit 1
        for (i = 1; i <= NF; i++) {
          if (!field_ok($i)) exit 1
        }
        if (!atomic_ok($2)) exit 1
        if (!atomic_ok($3)) exit 1
        if (!split_atomic_ok($9, "|")) exit 1
        if (!split_atomic_ok($12, "|")) exit 1
        if (!split_atomic_ok($13, ",")) exit 1
        if (!status_ok($14)) exit 1
        if (!uint_ok($15)) exit 1
        if (!status_ok($16)) exit 1
        if (!uint_ok($17)) exit 1
        if (!uint_ok($21)) exit 1
      }
    '
}

_state_row_from_args() {
  local incident_id="$1"
  shift

  if [[ "$#" -eq 1 && "$1" == *$'\t'* ]]; then
    local maybe_row="$1"
    local first_field="${maybe_row%%$'\t'*}"
    if [[ "$first_field" == "$incident_id" ]]; then
      printf '%s\n' "$maybe_row"
    else
      printf '%s\t%s\n' "$incident_id" "$maybe_row"
    fi
    return 0
  fi

  if [[ "$#" -eq "${#STATE_FILE_COLUMNS[@]}" ]]; then
    printf '%s\n' "$(_state_join_tabs "$@")"
    return 0
  fi

  if [[ "$#" -eq "$(( ${#STATE_FILE_COLUMNS[@]} - 1 ))" ]]; then
    local -a row=("$incident_id" "$@")
    printf '%s\n' "$(_state_join_tabs "${row[@]}")"
    return 0
  fi

  printf 'invalid row args for %s\n' "$incident_id" >&2
  return 1
}

_state_write_row_locked() {
  local state_file="$1"
  local incident_id="$2"
  local row="$3"

  _state_init_locked "$state_file" || return 1

  local tmp_file="${state_file}.tmp.$$"
  awk -F'\t' -v OFS='\t' -v id="$incident_id" -v new_row="$row" '
    NR == 1 { print; next }
    $1 == id && !done { print new_row; done = 1; next }
    { print }
    END { if (!done) print new_row }
  ' "$state_file" >"$tmp_file"

  _state_atomic_replace "$state_file" "$tmp_file"
}

state_write_row() {
  local incident_id="$1"
  shift

  local state_file
  state_file="$(state_default_file)"

  if [[ "$#" -ge 2 ]]; then
    local maybe_file="${!#}"
    if [[ "$maybe_file" == *.tsv || "$maybe_file" == */* ]]; then
      state_file="$maybe_file"
      set -- "${@:1:$#-1}"
    fi
  fi

  local row
  row="$(_state_row_from_args "$incident_id" "$@")" || return 1

  _state_validate_row "$row" || {
    printf 'invalid row content for %s\n' "$incident_id" >&2
    return 1
  }

  _state_with_lock "${state_file}.lock" _state_write_row_locked "$state_file" "$incident_id" "$row"
}

_state_archive_locked() {
  local state_file="$1"
  local archive_file="$2"
  local incident_id="$3"
  local reason="$4"
  local now_epoch="$5"

  _state_init_locked "$state_file" || return 1
  _state_init_archive_locked "$archive_file" || return 1

  local row
  row="$(awk -F'\t' -v id="$incident_id" 'NR>1 && $1==id {print; found=1; exit} END { if (!found) exit 1 }' "$state_file")" || return 1

  local tmp_state="${state_file}.tmp.$$"
  awk -F'\t' -v OFS='\t' -v id="$incident_id" '
    NR == 1 { print; next }
    $1 != id { print }
  ' "$state_file" >"$tmp_state"
  _state_atomic_replace "$state_file" "$tmp_state"

  local cutoff="$((now_epoch - 2592000))"
  local tmp_archive="${archive_file}.tmp.$$"
  awk -F'\t' -v OFS='\t' -v cutoff="$cutoff" '
    NR == 1 { print; next }
    NF < 23 { next }
    ($23 + 0) >= cutoff { print }
  ' "$archive_file" >"$tmp_archive"

  printf '%s\t%s\t%s\n' "$row" "$reason" "$now_epoch" >>"$tmp_archive"
  _state_atomic_replace "$archive_file" "$tmp_archive"
}

state_archive_row() {
  local incident_id="$1"
  local reason="$2"
  local state_file
  state_file="${3:-$(state_default_file)}"
  local archive_file
  archive_file="${4:-$(state_default_archive_file "$state_file")}" 
  local now_epoch
  now_epoch="$(_state_now_epoch)"

  _state_with_lock "${state_file}.lock" _state_archive_locked "$state_file" "$archive_file" "$incident_id" "$reason" "$now_epoch"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  cmd="${1:-}"
  case "$cmd" in
    init)
      state_init "${2:-$(state_default_file)}"
      ;;
    read-all)
      state_read_all "${2:-$(state_default_file)}"
      ;;
    read)
      state_read_incident "${2:?incident_id required}" "${3:-$(state_default_file)}"
      ;;
    *)
      printf 'usage: %s {init|read-all|read}\n' "$0" >&2
      exit 1
      ;;
  esac
fi
