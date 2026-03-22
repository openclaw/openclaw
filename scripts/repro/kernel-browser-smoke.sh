#!/usr/bin/env bash
set -euo pipefail

# Kernel is a remote browser infrastructure lane, not another agent loop.
# This wrapper keeps the experiment reproducible instead of relying on ad-hoc
# shell snippets that drift between worktrees.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  scripts/repro/kernel-browser-smoke.sh doctor
  scripts/repro/kernel-browser-smoke.sh smoke-open <url>
  scripts/repro/kernel-browser-smoke.sh open-emirates

Environment:
  KERNEL_API_KEY           Required for network actions
  KERNEL_HEADLESS=1        Optional; defaults to headed mode
  KERNEL_STEALTH=0         Optional; defaults to stealth on
  KERNEL_TIMEOUT_SECONDS   Optional; defaults to 900
  KERNEL_KEEP_BROWSER=1    Optional; keep the remote session alive
EOF
}

cmd="${1:-}"
shift || true

case "$cmd" in
  doctor|smoke-open|open-emirates)
    cd "$ROOT_DIR"
    node --import tsx scripts/repro/kernel-browser-smoke.ts "$cmd" "$@"
    ;;
  *)
    usage
    exit 1
    ;;
esac
