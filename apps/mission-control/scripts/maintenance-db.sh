#!/usr/bin/env bash
#
# maintenance-db.sh -- Periodic database maintenance for Mission Control.
#
# Usage:
#   bash ./scripts/maintenance-db.sh [OPTIONS]
#
# Options:
#   --db-path PATH         Override database path (default: data/mission-control.db)
#   --retention-days N     Activity log retention in days (default: 90)
#   --help                 Show this help message
#
# Operations performed:
#   1. Prune activity_log entries older than retention period
#   2. Run ANALYZE to update query planner statistics
#   3. Run VACUUM to reclaim space and defragment
#
# Safe to run while the application is serving (WAL mode).
#
# Make executable:  chmod +x scripts/maintenance-db.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DB_PATH="${PROJECT_ROOT}/data/mission-control.db"
RETENTION_DAYS=90

show_help() {
  sed -n '2,/^$/s/^# \?//p' "$0"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-path)
      DB_PATH="$2"
      shift 2
      ;;
    --retention-days)
      RETENTION_DAYS="$2"
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

if ! command -v sqlite3 &>/dev/null; then
  echo "Error: sqlite3 is not installed or not in PATH." >&2
  exit 1
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "Error: Database not found at $DB_PATH" >&2
  exit 2
fi

echo "Running database maintenance..."
echo "  Database:       $DB_PATH"
echo "  Retention:      $RETENTION_DAYS days"
echo ""

# 1. Prune old activity log entries
BEFORE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM activity_log;")
sqlite3 "$DB_PATH" "DELETE FROM activity_log WHERE created_at < datetime('now', '-${RETENTION_DAYS} days');"
AFTER=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM activity_log;")
PRUNED=$((BEFORE - AFTER))
echo "  Activity log:   pruned $PRUNED entries ($BEFORE -> $AFTER)"

# 2. Run ANALYZE
sqlite3 "$DB_PATH" "ANALYZE;"
echo "  ANALYZE:        done"

# 3. Get size before VACUUM
SIZE_BEFORE=$(wc -c < "$DB_PATH" | tr -d ' ')

# 4. Run VACUUM
sqlite3 "$DB_PATH" "VACUUM;"
SIZE_AFTER=$(wc -c < "$DB_PATH" | tr -d ' ')
SAVED=$(( (SIZE_BEFORE - SIZE_AFTER) / 1024 ))
echo "  VACUUM:         done (reclaimed ${SAVED} KB)"

# 5. Integrity check
if sqlite3 "$DB_PATH" "PRAGMA integrity_check;" | grep -q "^ok$"; then
  echo "  Integrity:      OK"
else
  echo "  Integrity:      FAILED — database may be corrupt" >&2
  exit 3
fi

echo ""
echo "Maintenance complete."
