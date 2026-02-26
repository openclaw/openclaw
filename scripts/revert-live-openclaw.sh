#!/usr/bin/env bash
set -euo pipefail

# Restore a previously backed-up global OpenClaw install tarball.
#
# Usage:
#   scripts/revert-live-openclaw.sh [backup-tgz] [--dry-run]
#
# Examples:
#   scripts/revert-live-openclaw.sh
#   scripts/revert-live-openclaw.sh .patch-backups/openclaw-global-backup-20260225-185329.tgz
#   scripts/revert-live-openclaw.sh --dry-run

DRY_RUN=0
BACKUP_ARG=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) BACKUP_ARG="$arg" ;;
  esac
done

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] %s\n' "$*"
  else
    eval "$@"
  fi
}

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$REPO_DIR/.patch-backups}"

if [[ -n "$BACKUP_ARG" ]]; then
  BACKUP_TGZ="$BACKUP_ARG"
else
  BACKUP_TGZ="$(ls -1t "$BACKUP_DIR"/openclaw-global-backup-*.tgz 2>/dev/null | head -n1 || true)"
fi

if [[ -z "$BACKUP_TGZ" ]]; then
  echo "error: no backup archive found. expected in: $BACKUP_DIR" >&2
  exit 1
fi

if [[ ! -f "$BACKUP_TGZ" ]]; then
  echo "error: backup archive not found: $BACKUP_TGZ" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

run "tar -xzf '$BACKUP_TGZ' -C '$TMP_DIR'"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] would restore global package from extracted openclaw/"
  echo "restorable backup: $BACKUP_TGZ"
  exit 0
fi

if [[ ! -f "$TMP_DIR/openclaw/package.json" ]]; then
  echo "error: backup archive does not contain openclaw/package.json" >&2
  exit 1
fi

RESTORE_SRC="$TMP_DIR/openclaw"
run "npm i -g '$RESTORE_SRC'"
run "openclaw --version"

echo "restored from: $BACKUP_TGZ"
