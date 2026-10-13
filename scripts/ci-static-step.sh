#!/usr/bin/env bash

# Sourced by trusted CI steps; native check owners still run every command.
ci_static_kind="$1"
case "$ci_static_kind" in
  tsgo|oxlint) ;;
  *) echo "Unsupported static check: $ci_static_kind" >&2; exit 64 ;;
esac
ci_static_groups=0
ci_static_exit=0

run_static_check() {
  local child_exit
  ci_static_groups=$((ci_static_groups + 1))
  if "$@"; then
    return 0
  else
    child_exit=$?
  fi
  # Timeouts and cancellation deliberately stop admitting new work.
  if [ "$child_exit" = 124 ] || [ "$child_exit" -ge 128 ]; then
    exit "$child_exit"
  fi
  if [ "$ci_static_exit" = 0 ]; then
    ci_static_exit="$child_exit"
  fi
}

finish_static_checks() {
  printf '[ci-static:%s:step] {"version":1,"groups":%s}\n' "$ci_static_kind" "$ci_static_groups"
  exit "$ci_static_exit"
}
