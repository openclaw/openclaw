#!/usr/bin/env bash
set -euo pipefail

# Build this repo and install the resulting package globally,
# with a backup of the currently installed global openclaw package.
#
# Usage:
#   scripts/patch-live-openclaw.sh [--dry-run]
#
# Env overrides:
#   OPENCLAW_REPO_DIR=/path/to/openclaw.git
#   BACKUP_DIR=/path/to/backups

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] %s\n' "$*"
  else
    eval "$@"
  fi
}

REPO_DIR="${OPENCLAW_REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_DIR/.patch-backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "error: REPO_DIR is not a git repo: $REPO_DIR" >&2
  exit 1
fi

cd "$REPO_DIR"

PACKAGE_DIR="$(npm root -g)/openclaw"
BACKUP_TGZ="$BACKUP_DIR/openclaw-global-backup-$TIMESTAMP.tgz"

run "mkdir -p '$BACKUP_DIR'"

if [[ -d "$PACKAGE_DIR" ]]; then
  run "tar -czf '$BACKUP_TGZ' -C '$(dirname "$PACKAGE_DIR")' '$(basename "$PACKAGE_DIR")'"
  echo "backup: $BACKUP_TGZ"
else
  echo "warning: global openclaw package dir not found at $PACKAGE_DIR"
fi

run "pnpm install --frozen-lockfile"
run "pnpm build"
run "pnpm test -- --run src/commands/models/auth.login-profiles.test.ts src/cli/models-cli.test.ts"

# Create tarball and install globally
run "rm -f ./openclaw-*.tgz"
run "npm pack"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] would install latest ./openclaw-*.tgz globally"
  echo "done (dry-run)"
  exit 0
fi

PKG_TGZ="$(ls -1t ./openclaw-*.tgz | head -n1)"
if [[ -z "$PKG_TGZ" ]]; then
  echo "error: npm pack did not produce a tarball" >&2
  exit 1
fi

run "npm i -g '$PKG_TGZ'"
run "openclaw --version"

echo "done"
