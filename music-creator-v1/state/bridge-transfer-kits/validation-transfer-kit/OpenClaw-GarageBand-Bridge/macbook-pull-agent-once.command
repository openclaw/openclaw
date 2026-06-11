#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="${0:A:h}"
exec "${BRIDGE_ROOT}/macbook-pull-agent.command" --once
