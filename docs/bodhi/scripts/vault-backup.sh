#!/usr/bin/env bash
# vault-backup.sh
# Backs up ~/openbodhi/vault to Hetzner S3 hudadata bucket.
# Called by OpenClaw cron weekly (Sundays 3am).
# Prints BACKUP_OK:<size> on success, BACKUP_FAIL:<reason> on failure.

set -euo pipefail

VAULT_DIR="${HOME}/openbodhi/vault"
BUCKET="s3://hudadata/backups/vault"
ENDPOINT="https://nbg1.your-objectstorage.com"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H%M%SZ")
BACKUP_KEY="${BUCKET}/${TIMESTAMP}/"
LOG_FILE="${HOME}/.openclaw/backup.log"

# Check vault exists
if [[ ! -d "$VAULT_DIR" ]]; then
    echo "BACKUP_FAIL: vault directory not found at $VAULT_DIR"
    exit 0
fi

# Count nodes
NODE_COUNT=$(find "$VAULT_DIR/nodes" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')

# Sync to S3 (aws cli must be configured with hudadata credentials)
if aws s3 sync "$VAULT_DIR" "$BACKUP_KEY" \
    --endpoint-url "$ENDPOINT" \
    --exclude "*.tmp" \
    --quiet 2>&1; then

    # Log success
    echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") OK nodes=${NODE_COUNT} dest=${BACKUP_KEY}" >> "$LOG_FILE"
    echo "BACKUP_OK:nodes=${NODE_COUNT},dest=${BACKUP_KEY}"
else
    ERR=$?
    echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") FAIL exit=${ERR}" >> "$LOG_FILE"
    echo "BACKUP_FAIL:aws s3 sync exited with code ${ERR}"
fi
