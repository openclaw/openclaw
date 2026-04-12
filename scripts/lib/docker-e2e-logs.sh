#!/usr/bin/env bash

run_logged() {
  local label="$1"
  shift
  local log_file
  log_file="$(mktemp "${TMPDIR:-/tmp}/openclaw-${label}.XXXXXX.log")"
  if ! "$@" >"$log_file" 2>&1; then
    cat "$log_file"
    rm -f "$log_file"
    return 1
  fi
  rm -f "$log_file"
}
