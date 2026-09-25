#!/usr/bin/env bash

# Both guided drivers choose the producer's explicit default "One agent" before
# accepting its name. Older candidates go directly to the name prompt.
# Callers provide their log predicate and existing send function/input custody.
wait_for_first_agent_prompt() {
  local contains_fn="${1:?missing log predicate}"
  local timeout_s="${2:?missing prompt timeout}"
  local send_delay="${3:?missing input delay}"
  local started_s="$SECONDS"
  local creation_answered=0
  if [[ ! "$timeout_s" =~ ^[1-9][0-9]*$ ]]; then
    echo "Invalid first-agent prompt timeout" >&2
    return 2
  fi
  while true; do
    if "$contains_fn" "What should we call your first agent?"; then
      return 0
    fi
    if (( SECONDS - started_s >= timeout_s )); then
      echo "Timeout waiting for first-agent prompt (creation answered: $creation_answered)" >&2
      return 1
    fi
    if [[ "$creation_answered" == 0 ]] &&
      "$contains_fn" "What would you like to create?" &&
      "$contains_fn" "One agent"; then
      # promptFirstOnboardingAgent renders initialValue="one". Acknowledge this
      # observed menu once; never send an extra Enter to the legacy name prompt.
      send $'\r' "$send_delay" || return $?
      creation_answered=1
    fi
    sleep 0.2
  done
}
