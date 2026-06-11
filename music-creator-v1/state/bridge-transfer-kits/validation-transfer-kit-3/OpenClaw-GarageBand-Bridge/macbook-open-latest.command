#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="${0:A:h}"
LATEST="$(ls -td "${BRIDGE_ROOT}"/to-macbook/*(/N) 2>/dev/null | head -n 1)"

if [[ -z "${LATEST}" ]]; then
  echo "No GarageBand bridge jobs found in ${BRIDGE_ROOT}/to-macbook"
  exit 1
fi

exec "${LATEST}/open-in-garageband.command"
