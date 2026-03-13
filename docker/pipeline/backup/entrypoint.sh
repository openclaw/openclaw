#!/usr/bin/env bash
set -euo pipefail

: "${BACKUP_CRON:=0 3 * * *}"

echo "[backup-sidecar] Scheduling backup: ${BACKUP_CRON}"

CRON_LINE="${BACKUP_CRON} /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1"
echo "${CRON_LINE}" | crontab -

echo "[backup-sidecar] Running initial backup on startup..."
/usr/local/bin/backup.sh || echo "[backup-sidecar] Initial backup failed (non-fatal)"

echo "[backup-sidecar] Starting crond..."
exec crond -f -l 2
