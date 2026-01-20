#!/usr/bin/env bash
set -euo pipefail

# Build macOS companion app from a clean upstream release (no hotfixes)
#
# Usage: ./scripts/build-mac-clean.sh <version>
# Example: ./scripts/build-mac-clean.sh v2026.1.15

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 v2026.1.6"
  exit 1
fi

# Source shared build logic
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/build-mac-release-common.sh
source "$SCRIPT_DIR/lib/build-mac-release-common.sh"

# Call shared function with hotfixes disabled
build_mac_release_worktree "$VERSION" "false"
