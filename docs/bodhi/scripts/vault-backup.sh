#!/usr/bin/env bash
# vault-backup.sh
# Backs up the Obsidian vault (~/.alfred/vault/) to Hetzner S3 hudadata bucket.
# Streams tar.gz directly to S3 — no temp file on disk.
#
# Called by:
#   openbodhi backup        — manual run
#   openbodhi setup         — after token swap completes
#   OpenClaw cron           — weekly Sundays 3am UTC
#
# Outputs:
#   BACKUP_OK:<key>         on success
#   BACKUP_FAIL:<reason>    on failure
#
# Required env (or configure ~/.aws/credentials with profile bodhi-backup):
#   AWS_ACCESS_KEY_ID       hudadata access key
#   AWS_SECRET_ACCESS_KEY   hudadata secret key
#   S3_ENDPOINT_URL         https://nbg1.your-objectstorage.com
#   S3_BACKUP_BUCKET        s3://hudadata/backups/obsidian  (default)

set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────────────────
VAULT_DIR="${OBSIDIAN_VAULT_DIR:-$HOME/.alfred/vault}"
BUCKET="${S3_BACKUP_BUCKET:-s3://hudadata/backups/obsidian}"
ENDPOINT="${S3_ENDPOINT_URL:-https://nbg1.your-objectstorage.com}"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H%M%SZ")"
ARCHIVE_KEY="${BUCKET}/${TIMESTAMP}.tar.gz"
LOG_FILE="${HOME}/.openclaw/backup.log"
AWS_PROFILE="${AWS_PROFILE:-bodhi-backup}"

# ─── Preflight ────────────────────────────────────────────────────────────────
if [[ ! -d "$VAULT_DIR" ]]; then
  msg="BACKUP_FAIL: vault not found at ${VAULT_DIR}"
  echo "$msg"
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") ${msg}" >> "$LOG_FILE" 2>/dev/null || true
  exit 1
fi

if ! command -v aws &>/dev/null; then
  msg="BACKUP_FAIL: aws cli not installed"
  echo "$msg"
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") ${msg}" >> "$LOG_FILE" 2>/dev/null || true
  exit 1
fi

# ─── Count files for reporting ────────────────────────────────────────────────
FILE_COUNT="$(find "$VAULT_DIR" -type f ! -name "*.tmp" ! -name ".DS_Store" | wc -l | tr -d ' ')"
NODE_COUNT="0"
if [[ -f "$VAULT_DIR/nodes.json" ]]; then
  NODE_COUNT="$(python3 -c "import json; print(len(json.load(open('$VAULT_DIR/nodes.json'))))" 2>/dev/null || echo 0)"
fi

# ─── Stream to S3 ─────────────────────────────────────────────────────────────
# tar → gzip → aws s3 cp (reads from stdin)
# Excludes: .DS_Store, .tmp files, .git dirs, node_modules
if tar \
    --exclude="$VAULT_DIR/.git" \
    --exclude="$VAULT_DIR/node_modules" \
    --exclude="*.tmp" \
    --exclude=".DS_Store" \
    -czf - \
    -C "$(dirname "$VAULT_DIR")" \
    "$(basename "$VAULT_DIR")" \
  | aws s3 cp - "$ARCHIVE_KEY" \
      --endpoint-url "$ENDPOINT" \
      --profile "$AWS_PROFILE" \
      --no-progress \
      2>&1; then

  SIZE="$(aws s3 ls "$ARCHIVE_KEY" \
      --endpoint-url "$ENDPOINT" \
      --profile "$AWS_PROFILE" \
      2>/dev/null | awk '{print $3}' || echo "?")"

  log_entry="$(date -u +"%Y-%m-%dT%H:%M:%SZ") OK files=${FILE_COUNT} nodes=${NODE_COUNT} size=${SIZE} key=${ARCHIVE_KEY}"
  echo "$log_entry" >> "$LOG_FILE" 2>/dev/null || true
  echo "BACKUP_OK:${ARCHIVE_KEY}"

else
  ERR=$?
  log_entry="$(date -u +"%Y-%m-%dT%H:%M:%SZ") FAIL exit=${ERR} key=${ARCHIVE_KEY}"
  echo "$log_entry" >> "$LOG_FILE" 2>/dev/null || true
  echo "BACKUP_FAIL:aws s3 cp exited ${ERR}"
  exit 1
fi
