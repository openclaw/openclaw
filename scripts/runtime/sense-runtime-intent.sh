#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage:
  sense-runtime-intent.sh "sense runtime status" [tool options]
  sense-runtime-intent.sh "sense runtime start" [tool options]
  sense-runtime-intent.sh "sense runtime stop" [tool options]
  sense-runtime-intent.sh "sense sandbox status" [tool options]

Accepted direct actions:
  status
  start
  stop
  sandbox-status
EOF
}

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 2
fi

args=("$@")
action=""
remaining_start=1

normalize_words() {
  local joined
  joined="$*"
  joined="${joined,,}"
  joined="${joined//_/ }"
  joined="${joined//-/ }"
  echo "$joined"
}

first_normalized="$(normalize_words "${args[0]}")"
case "$first_normalized" in
  status|start|stop)
    action="$first_normalized"
    remaining_start=1
    ;;
  "sandbox status")
    action="sandbox-status"
    remaining_start=1
    ;;
  "sense runtime status")
    action="status"
    remaining_start=1
    ;;
  "sense runtime start")
    action="start"
    remaining_start=1
    ;;
  "sense runtime stop")
    action="stop"
    remaining_start=1
    ;;
  "sense sandbox status")
    action="sandbox-status"
    remaining_start=1
    ;;
  *)
    words=()
    for token in "${args[@]}"; do
      if [[ "$token" == --* ]]; then
        break
      fi
      words+=("${token,,}")
      if [[ ${#words[@]} -ge 3 ]]; then
        break
      fi
    done

    if [[ ${#words[@]} -ge 3 && "${words[0]}" == "sense" && "${words[1]}" == "runtime" ]]; then
      case "${words[2]}" in
        status|start|stop)
          action="${words[2]}"
          remaining_start=3
          ;;
      esac
    elif [[ ${#words[@]} -ge 3 && "${words[0]}" == "sense" && "${words[1]}" == "sandbox" && "${words[2]}" == "status" ]]; then
      action="sandbox-status"
      remaining_start=3
    elif [[ ${#words[@]} -ge 1 ]]; then
      case "${words[0]}" in
        status|start|stop)
          action="${words[0]}"
          remaining_start=1
          ;;
        sandbox-status)
          action="sandbox-status"
          remaining_start=1
          ;;
      esac
    fi
    ;;
esac

if [[ -z "$action" ]]; then
  echo "Unsupported intent. Expected one of: sense runtime status, sense runtime start, sense runtime stop, sense sandbox status" >&2
  usage >&2
  exit 2
fi

remaining=("${args[@]:$remaining_start}")
exec "$SCRIPT_DIR/sense-runtime-tool.sh" "$action" "${remaining[@]}"
