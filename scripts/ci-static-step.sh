#!/usr/bin/env bash

# Sourced by trusted CI steps; native check owners still run every command.
ci_static_kind="$1"
case "$ci_static_kind" in
  tsgo) ci_static_failure=2 ;;
  oxlint) ci_static_failure=1 ;;
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
  if [ "${OPENCLAW_CI_STATIC_EVIDENCE:-0}" != "1" ] || [ "$child_exit" != "$ci_static_failure" ]; then
    exit "$child_exit"
  fi
  ci_static_exit="$child_exit"
}

finish_static_checks() {
  if [ "${OPENCLAW_CI_STATIC_EVIDENCE:-0}" = "1" ]; then
    printf '[ci-static:%s:step] {"version":1,"groups":%s}\n' "$ci_static_kind" "$ci_static_groups"
  fi
  exit "$ci_static_exit"
}
