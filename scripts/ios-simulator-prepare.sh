#!/bin/bash

set -euo pipefail

# The binary path is an internal, step-scoped CI opt-in. Local runs stay stock.
simslim_binary="${OPENCLAW_CI_SIMSLIM_BINARY:-}"
[[ -n "$simslim_binary" ]] || exit 0

if [[ "${CI:-}" != "true" ]]; then
  echo "iOS simulator preparation with simslim is CI-only" >&2
  exit 1
fi
if [[ "$#" -ne 1 || ! "$1" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]]; then
  echo "usage: $0 <simulator-udid>" >&2
  exit 2
fi
if [[ "$simslim_binary" != /* || ! -x "$simslim_binary" ]]; then
  echo "OPENCLAW_CI_SIMSLIM_BINARY must be an absolute executable path" >&2
  exit 1
fi

simulator_id="$1"
# Disable only Spotlight search and Family/Screen Time, retaining app capabilities.
readonly kept_categories="widgets,siri,icloud,store,pim,web,health,photos,apps,messaging,connectivity,telemetry,other"

run_timed() {
  local phase="$1"
  shift
  local status=0
  local TIMEFORMAT
  # Bash's elapsed wall time adds no timer subprocesses or command-output capture.
  time {
    "$@" || status=$?
    TIMEFORMAT=$'\n'"OPENCLAW_SIMULATOR_TIMING phase=$phase seconds=%3R exit=$status"
  }
  return "$status"
}

# Finish the initial cold boot before starting SimSlim's reconfiguration deadline.
run_timed cold-boot xcrun simctl bootstatus "$simulator_id" -b
run_timed configure "$simslim_binary" on "$simulator_id" --except "$kept_categories"
run_timed ready xcrun simctl bootstatus "$simulator_id" -b
run_timed verify "$simslim_binary" verify "$simulator_id" --except "$kept_categories"
