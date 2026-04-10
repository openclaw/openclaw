#!/usr/bin/env bash
# Generic verification dispatcher used by tasks that need a wrapper around
# their `Verify` command. Most tasks can use their verify command directly;
# this script exists for tasks that need extra setup (e.g. temp state dirs,
# isolated test harness) before running the actual check.
#
# Usage:
#   bash verify.sh <task_id> -- <verify command>
#
# Example:
#   bash verify.sh M1-03 -- npm test -- src/octo/head/event-log.test.ts -t append

set -euo pipefail

task_id="${1:-}"
shift || true
[[ "${1:-}" == "--" ]] && shift || true

if [[ -z "$task_id" ]]; then
    echo "verify.sh: missing task id" >&2
    exit 2
fi

REPO_ROOT="${REPO_ROOT:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}"
cd "$REPO_ROOT"

# Per-task setup (if any)
case "$task_id" in
    M1-01|M1-02|M1-03|M1-04|M1-05|M1-06|M1-13|M1-14|M1-15|M1-16|M1-17|M1-18|M1-19|M1-20|M1-21|M1-22|M1-23|M1-25|M1-26|M1-27|M1-28|M1-29)
        # Runtime tasks: ensure temp octo state dir
        export OCTO_STATE_DIR="${OCTO_STATE_DIR:-$(mktemp -d -t octo-test-XXXXXX)}"
        trap 'rm -rf "$OCTO_STATE_DIR"' EXIT
        ;;
esac

# Run the actual verify command
"$@"
