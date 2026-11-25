#!/usr/bin/env bash

# Independent checks finish before the caller reports their aggregate failure.
ci_check_failures=0

prepare_ratchet_base_args() {
  local base="$1"
  git cat-file -e "${base}^{commit}" || return
  ratchet_base_args=(--base "$base")
  # The checkout owner proved this comparison commit before shallow checkout.
  # Historical targets retain their parser and must not receive an unknown flag.
  if node --input-type=module -e '
    const { parseRatchetArgs } = await import("./scripts/lib/shrink-ratchet.mts");
    const args = parseRatchetArgs(["--base", process.argv[1], "--no-merge-base"]);
    process.exit(args.mergeBase === false ? 0 : 1);
  ' "$base" >/dev/null 2>&1; then
    ratchet_base_args+=(--no-merge-base)
  fi
}

run_check() {
  local label="$1"
  shift
  local child_exit restore_errexit=0
  case "$-" in *e*) restore_errexit=1 ;; esac

  echo "::group::${label}"
  # An `if command` guard disables errexit inside Bash functions as well.
  # Keep each check's setup dependencies intact in its own strict subshell.
  set +e
  (set -e; "$@")
  child_exit=$?
  if [ "$restore_errexit" = 1 ]; then
    set -e
  fi
  if [ "$child_exit" = 0 ]; then
    echo "[ok] ${label}"
  else
    echo "::error title=${label} failed::${label} failed (exit ${child_exit})"
    ci_check_failures=1
  fi
  echo "::endgroup::"
  # Watchdog deadlines and signals deliberately stop admitting more work.
  if [ "$child_exit" -eq 124 ] || [ "$child_exit" -ge 128 ]; then
    exit "$child_exit"
  fi
}

finish_checks() {
  return "$ci_check_failures"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  for check_command in "$@"; do
    run_check "$check_command" bash -euo pipefail -c "$check_command"
  done
  finish_checks
fi
