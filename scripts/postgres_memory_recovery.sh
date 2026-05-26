#!/usr/bin/env bash
set -euo pipefail

DB_CONT="${DB_CONT:-local-postgres}"
DB_USER="${DB_USER:-zorg}"
DB_NAME="${DB_NAME:-zorgdb}"
BACKUP_DIR="${BACKUP_DIR:-/home/openclaw/.openclaw/backups/postgres/local}"
WORKSPACE="${OPENCLAW_WORKSPACE:-/home/openclaw/.openclaw/workspace}"
MODE="${1:-drill}"
BACKUP_FILE="${2:-}"

usage() {
  cat <<USAGE
Usage:
  $0 drill [backup.sql.gz]
  $0 list
  $0 restore-active backup.sql.gz

Modes:
  list            List candidate full backups newest first.
  drill           Restore a backup into a temporary PostgreSQL database, verify it, then drop the temp DB.
  restore-active  Restore a verified backup into the live DB. Requires CONFIRM_RESTORE_ACTIVE=YES.

Defaults:
  DB_CONT=$DB_CONT
  DB_USER=$DB_USER
  DB_NAME=$DB_NAME
  BACKUP_DIR=$BACKUP_DIR
USAGE
}

log() {
  printf '[%s] %s\n' "$(date -Is)" "$*"
}

docker_psql() {
  docker exec "$DB_CONT" psql -U "$DB_USER" -v ON_ERROR_STOP=1 "$@"
}

list_backups() {
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'zorgdb-*.sql.gz' ! -name 'zorgdb-schema-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null | sort -nr | awk '{ $1=""; sub(/^ /, ""); print }'
}

latest_backup() {
  list_backups | head -n 1
}

require_backup() {
  local candidate="$1"
  if [ -z "$candidate" ]; then
    candidate="$(latest_backup)"
  fi
  if [ -z "$candidate" ] || [ ! -s "$candidate" ]; then
    echo "ERROR: no readable full backup found. Set BACKUP_DIR or pass backup.sql.gz." >&2
    exit 2
  fi
  printf '%s\n' "$candidate"
}

verify_db() {
  local db="$1"
  docker_psql -d "$db" -Atc "select to_regclass('public.zorg_memory') is not null" | grep -qx 't'
  local count
  count="$(docker_psql -d "$db" -Atc "select count(*) from public.zorg_memory")"
  case "$count" in
    ''|*[!0-9]*) echo "ERROR: invalid zorg_memory row count: $count" >&2; exit 3 ;;
  esac
  if [ "$count" -lt 1 ]; then
    echo "ERROR: restored backup has zero zorg_memory rows" >&2
    exit 3
  fi
  docker_psql -d "$db" -Atc "select coalesce(max(logged_at)::text, 'no_logged_at') from public.zorg_memory" >/dev/null
  log "verified database $db with zorg_memory rows=$count"
}

restore_plain_sql() {
  local backup="$1"
  local db="$2"
  log "restoring $(basename "$backup") into $db"
  gunzip -c "$backup" | docker exec -i -e PGOPTIONS="-c maintenance_work_mem=16MB -c max_parallel_maintenance_workers=0" "$DB_CONT" psql -U "$DB_USER" -d "$db" -v ON_ERROR_STOP=1 >/tmp/zorg-memorydb-restore-$$.log
}

drill_restore() {
  local backup
  backup="$(require_backup "$BACKUP_FILE")"
  local temp_db
  temp_db="zorg_recovery_drill_$(date +%Y%m%d_%H%M%S)_$$"
  log "starting recovery drill using $backup"
  docker_psql -d postgres -c "create database \"$temp_db\" owner \"$DB_USER\";" >/dev/null
  cleanup() {
    docker_psql -d postgres -c "drop database if exists \"$1\" with (force);" >/dev/null || true
  }
  trap "cleanup '$temp_db'" EXIT
  restore_plain_sql "$backup" "$temp_db"
  verify_db "$temp_db"
  log "recovery drill passed; temporary database will be dropped"
}

restore_active() {
  local backup
  backup="$(require_backup "$BACKUP_FILE")"
  if [ "${CONFIRM_RESTORE_ACTIVE:-}" != "YES" ]; then
    echo "ERROR: restore-active replaces live $DB_NAME. Re-run with CONFIRM_RESTORE_ACTIVE=YES after approval." >&2
    exit 4
  fi
  log "testing backup before live restore"
  BACKUP_FILE="$backup" "$0" drill "$backup"
  local safety_db="zorg_restore_safety_$(date +%Y%m%d_%H%M%S)"
  log "renaming live database $DB_NAME to $safety_db"
  docker_psql -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$DB_NAME';" >/dev/null
  docker_psql -d postgres -c "alter database \"$DB_NAME\" rename to \"$safety_db\";" >/dev/null
  docker_psql -d postgres -c "create database \"$DB_NAME\" owner \"$DB_USER\";" >/dev/null
  restore_plain_sql "$backup" "$DB_NAME"
  verify_db "$DB_NAME"
  log "live restore verified. Previous database retained as $safety_db for manual rollback."
}

case "$MODE" in
  list)
    list_backups
    ;;
  drill)
    drill_restore
    ;;
  restore-active)
    restore_active
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
