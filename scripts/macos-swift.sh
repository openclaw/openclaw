#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WITH_XCODE_DEVELOPER_DIR="${ROOT_DIR}/scripts/with-xcode-developer-dir.sh"
MACOS_DIR="${ROOT_DIR}/apps/macos"

if [[ $# -eq 0 ]]; then
  echo "Usage: scripts/macos-swift.sh <swift-subcommand> [args...]" >&2
  echo "Example: scripts/macos-swift.sh test --filter VoiceWakeRuntimeTests" >&2
  exit 1
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ $# -eq 0 ]]; then
  echo "Usage: scripts/macos-swift.sh <swift-subcommand> [args...]" >&2
  exit 1
fi

if [[ $# -ge 2 && "${2:-}" == "--" ]]; then
  set -- "$1" "${@:3}"
fi

cd "${MACOS_DIR}"
exec "${WITH_XCODE_DEVELOPER_DIR}" swift "$@"
