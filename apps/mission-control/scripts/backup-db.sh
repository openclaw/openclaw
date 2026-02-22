#!/usr/bin/env bash
#
# backup-db.sh -- Safe online backup of the Mission Control SQLite database.
#
# Usage:
#   bash ./scripts/backup-db.sh [OPTIONS]
#
# Options:
#   --backup-dir DIR       Directory to store backups (default: .backups/)
#   --retention-days N     Delete backups older than N days (default: 7)
#   --db-path PATH         Override database path (default: data/mission-control.db)
#   --help                 Show this help message
#
# The script uses SQLite's .backup command, which is safe to run while the
# application is serving requests (the database uses WAL journal mode).
#
# Exit codes:
#   0  Success
#   1  General error (missing tool, bad arguments)
#   2  Database file not found
#   3  Backup failed
#
# Make executable:  chmod +x scripts/backup-db.sh

set -euo pipefail

# ──────────────────────────────────────────────
# Defaults
# ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DB_PATH="${PROJECT_ROOT}/data/mission-control.db"
BACKUP_DIR="${PROJECT_ROOT}/.backups"
RETENTION_DAYS=7

# ──────────────────────────────────────────────
# Parse arguments
# ──────────────────────────────────────────────
show_help() {
  sed -n '2,/^$/s/^# \?//p' "$0"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-dir)
      BACKUP_DIR="$2"
      shift 2
      ;;
    --retention-days)
      RETENTION_DAYS="$2"
      shift 2
      ;;
    --db-path)
      DB_PATH="$2"
      shift 2
      ;;
    --help|-h)
      show_help
      ;;
    *)
      echo "Error: Unknown option '$1'" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

# ──────────────────────────────────────────────
# Validate
# ──────────────────────────────────────────────
if ! command -v sqlite3 &>/dev/null; then
  echo "Error: sqlite3 is not installed or not in PATH." >&2
  exit 1
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "Error: Database not found at $DB_PATH" >&2
  echo "Has the application been started at least once?" >&2
  exit 2
fi

if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || [[ "$RETENTION_DAYS" -lt 1 ]]; then
  echo "Error: --retention-days must be a positive integer (got '$RETENTION_DAYS')." >&2
  exit 1
fi

# ──────────────────────────────────────────────
# Prepare backup directory
# ──────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"

# ──────────────────────────────────────────────
# Perform backup
# ──────────────────────────────────────────────
TIMESTAMP="$(date +%Y-%m-%d-%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/mission-control-${TIMESTAMP}.db"

echo "Backing up database..."
echo "  Source:    $DB_PATH"
echo "  Dest:      $BACKUP_FILE"

if sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"; then
  BACKUP_SIZE=$(wc -c < "$BACKUP_FILE" | tr -d ' ')
  echo "  Size:      $(( BACKUP_SIZE / 1024 )) KB"
  echo "Backup complete."
else
  echo "Error: sqlite3 .backup command failed." >&2
  rm -f "$BACKUP_FILE"
  exit 3
fi

# ──────────────────────────────────────────────
# Verify the backup is a valid SQLite database
# ──────────────────────────────────────────────
if ! sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" &>/dev/null; then
  echo "Warning: Backup integrity check failed. The file may be corrupt." >&2
  exit 3
fi

# ──────────────────────────────────────────────
# Retention: remove old backups
# ──────────────────────────────────────────────
echo "Pruning backups older than ${RETENTION_DAYS} days..."

PRUNED=0
# Use -mtime on Linux, which also works on macOS (BSD find supports -mtime +N)
while IFS= read -r -d '' old_backup; do
  echo "  Removing: $(basename "$old_backup")"
  rm -f "$old_backup"
  PRUNED=$((PRUNED + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -name 'mission-control-*.db' -type f -mtime +"$RETENTION_DAYS" -print0 2>/dev/null)

if [[ "$PRUNED" -eq 0 ]]; then
  echo "  No old backups to remove."
else
  echo "  Removed $PRUNED backup(s)."
fi

# ──────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────
TOTAL=$(find "$BACKUP_DIR" -maxdepth 1 -name 'mission-control-*.db' -type f | wc -l | tr -d ' ')
echo ""
echo "Done. ${TOTAL} backup(s) in ${BACKUP_DIR}."
