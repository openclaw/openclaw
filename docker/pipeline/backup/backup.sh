#!/usr/bin/env bash
set -euo pipefail

: "${POSTGRES_HOST:?}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_DB:?}"
: "${POSTGRES_USER:?}"
: "${PGPASSWORD:?}"
: "${S3_BACKUP_BUCKET:?}"
: "${BACKUP_RETAIN_DAYS:=30}"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="${POSTGRES_DB}_${TIMESTAMP}.sql.gz"
LOCAL_PATH="/tmp/${FILENAME}"

echo "[backup] Starting pg_dump for ${POSTGRES_DB} at ${TIMESTAMP}"

pg_dump \
  -h "${POSTGRES_HOST}" \
  -p "${POSTGRES_PORT}" \
  -U "${POSTGRES_USER}" \
  -d "${POSTGRES_DB}" \
  --no-owner \
  --no-privileges \
  | gzip > "${LOCAL_PATH}"

SIZE="$(du -h "${LOCAL_PATH}" | cut -f1)"
echo "[backup] Dump complete: ${FILENAME} (${SIZE})"

S3_KEY="openclaw-pipeline/${FILENAME}"
echo "[backup] Uploading to s3://${S3_BACKUP_BUCKET}/${S3_KEY}"
aws s3 cp "${LOCAL_PATH}" "s3://${S3_BACKUP_BUCKET}/${S3_KEY}" --quiet

rm -f "${LOCAL_PATH}"

if [ "${BACKUP_RETAIN_DAYS}" -gt 0 ]; then
  CUTOFF="$(date -u -d "${BACKUP_RETAIN_DAYS} days ago" +%Y%m%d 2>/dev/null || date -u -v-"${BACKUP_RETAIN_DAYS}"d +%Y%m%d 2>/dev/null || echo "")"
  if [ -n "${CUTOFF}" ]; then
    echo "[backup] Pruning S3 backups older than ${BACKUP_RETAIN_DAYS} days (before ${CUTOFF})"
    aws s3 ls "s3://${S3_BACKUP_BUCKET}/openclaw-pipeline/" --recursive \
      | awk '{print $4}' \
      | grep -E '\.sql\.gz$' \
      | while IFS= read -r key; do
          FILE_DATE="$(echo "${key}" | grep -oE '[0-9]{8}T' | head -1 | tr -d 'T')"
          if [ -n "${FILE_DATE}" ] && [ "${FILE_DATE}" -lt "${CUTOFF}" ]; then
            echo "[backup] Deleting old backup: ${key}"
            aws s3 rm "s3://${S3_BACKUP_BUCKET}/${key}" --quiet
          fi
        done
  fi
fi

echo "[backup] Done."
