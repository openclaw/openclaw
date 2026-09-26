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
"$simslim_binary" on "$simulator_id" --except "$kept_categories"
xcrun simctl bootstatus "$simulator_id" -b
"$simslim_binary" verify "$simulator_id" --except "$kept_categories"
