#!/usr/bin/env bash
# signal-backup.sh — backs up signal-cli account data to internal SSD (~/.maxbot/signal-backup)
# Safe to run at any time (signal-cli can be running).
# Does NOT back up stickers — they are large and re-downloadable.
# Usage: bash scripts/signal-backup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.safe"

# Safe env reader — grep-based so paths with spaces in .env.safe don't break bash
get_env() {
  local key="$1" default="${2:-}"
  local val
  val=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
  echo "${val:-$default}"
}

SIGNAL_CLI_DATA_DIR=$(get_env SIGNAL_CLI_DATA_DIR "/Volumes/Crucial Deez X9 Pro/openclaw_safe_live/config/signal-cli")
BACKUP_DIR="${HOME}/.maxbot/signal-backup"
SRC="${SIGNAL_CLI_DATA_DIR}/data"

echo "━━━ Signal Account Backup ━━━"
echo "  Source: ${SRC}"
echo "  Dest:   ${BACKUP_DIR}/data"
echo ""

if [ ! -d "$SRC" ]; then
  echo "ERROR: Source directory not found: ${SRC}" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}/data"

# accounts.json
if [ -f "${SRC}/accounts.json" ]; then
  cp -p "${SRC}/accounts.json" "${BACKUP_DIR}/data/accounts.json"
  echo "  Copied accounts.json"
fi

# Account database directories (each is a number like "169016.d")
for dir in "${SRC}"/*.d; do
  [ -d "$dir" ] || continue
  DNAME=$(basename "$dir")
  mkdir -p "${BACKUP_DIR}/data/${DNAME}"
  for f in account.db account.db-shm account.db-wal storage-manifest; do
    [ -f "${dir}/${f}" ] && cp -p "${dir}/${f}" "${BACKUP_DIR}/data/${DNAME}/${f}" || true
  done
  echo "  Copied ${DNAME}/"
done

# Flat key files alongside the .d directory (e.g. "169016")
for f in "${SRC}"/[0-9]*; do
  [ -f "$f" ] || continue
  cp -p "$f" "${BACKUP_DIR}/data/$(basename "$f")"
  echo "  Copied $(basename "$f")"
done

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "$TIMESTAMP" > "${BACKUP_DIR}/backup-timestamp.txt"

echo ""
echo "✅ Backup complete — ${TIMESTAMP}"
echo ""
echo "To restore if account data is lost:"
echo "  1. docker stop openclaw-signal"
echo "  2. cp -rp ${BACKUP_DIR}/data/* ${SRC}/"
echo "  3. docker compose --env-file .env.safe up -d signal-cli"
