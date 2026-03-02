#!/usr/bin/env bash
set -euo pipefail

# Anthropic seat sweep (quarantined):
# - Runs N concurrent calls via president-a (pinned to anthropic/claude-sonnet-4-6)
# - Stops at first failure / non-matching echo
#
# Usage: ops/scripts/anthropic_seat_sweep.sh 1 2 4 6 8

cd "$HOME/openclaw-workspace/repos/openclaw"

shot="ANTHRO_SEAT_OK_$(date +%s)"

run_n() {
  local n="$1"
  echo "== seats=$n =="
  rm -f /tmp/anthro_seat_out.*.txt || true
  for i in $(seq 1 "$n"); do
    (
      timeout 140 "$HOME/bin/openclaw-safe" agent \
        --agent president-a \
        --session-id "anthro-seat-${n}-${i}-$(date +%s)" \
        --timeout 90 \
        --thinking off \
        --message "Reply with EXACTLY: ${shot}" \
        --json | jq -r ".result.payloads[0].text // \"\"" \
        > "/tmp/anthro_seat_out.${n}.${i}.txt"
    ) &
  done
  wait

  bad=0
  for i in $(seq 1 "$n"); do
    got="$(cat "/tmp/anthro_seat_out.${n}.${i}.txt" 2>/dev/null || true)"
    if [[ "$got" != "$shot" ]]; then
      echo "FAIL seat=$n i=$i got='$got'"
      bad=1
    fi
  done

  if [[ "$bad" -eq 0 ]]; then
    echo "PASS seats=$n"
  else
    echo "STOP at seats=$n"
    exit 42
  fi
  echo
}

if [[ "$#" -lt 1 ]]; then
  echo "Usage: $0 1 2 4 6 8"
  exit 2
fi

for n in "$@"; do
  run_n "$n"
done
