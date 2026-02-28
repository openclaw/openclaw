#!/bin/bash
# Backup OpenClaw configuration and session data
# 
# Usage: docker compose run --rm backup-config
# Creates timestamped backup of /data/.openclaw/ directory
# 
# Location: ./backups/openclaw.json.<YYYYMMDD-HHMMSS>
# Also backs up: sessions/ and exec-approvals.json

set -euo pipefail

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/backups"
SOURCE_DIR="/data/.openclaw"

echo "==================================================="
echo "OpenClaw Configuration Backup"
echo "Timestamp: $TIMESTAMP"
echo "==================================================="

# Create backup directory if missing
mkdir -p "$BACKUP_DIR"

# Backup config file
if [ -f "$SOURCE_DIR/openclaw.json" ]; then
  BACKUP_FILE="$BACKUP_DIR/openclaw.json.$TIMESTAMP"
  cp "$SOURCE_DIR/openclaw.json" "$BACKUP_FILE"
  echo "✓ Config backed up: $BACKUP_FILE"
  echo "  Size: $(du -h "$BACKUP_FILE" | cut -f1)"
else
  echo "⚠ Config file not found: $SOURCE_DIR/openclaw.json"
fi

# Backup exec-approvals file
if [ -f "$SOURCE_DIR/exec-approvals.json" ]; then
  APPROVALS_BACKUP="$BACKUP_DIR/exec-approvals.json.$TIMESTAMP"
  cp "$SOURCE_DIR/exec-approvals.json" "$APPROVALS_BACKUP"
  echo "✓ Exec approvals backed up: $APPROVALS_BACKUP"
fi

# Count sessions
SESSION_COUNT=$(find "$SOURCE_DIR/agents/main/sessions" -type f -name "*.jsonl" 2>/dev/null | wc -l || echo "0")
echo "✓ Sessions: $SESSION_COUNT files in sessions directory"

# Keep only last 5 backups (rotate old ones)
BACKUP_COUNT=$(ls -1 "$BACKUP_DIR"/openclaw.json.* 2>/dev/null | wc -l || echo "0")
if [ "$BACKUP_COUNT" -gt 5 ]; then
  echo ""
  echo "Rotating old backups (keeping last 5)..."
  ls -1t "$BACKUP_DIR"/openclaw.json.* | tail -n +6 | while read -r old_backup; do
    echo "  Deleting: $(basename "$old_backup")"
    rm "$old_backup"
  done
fi

echo ""
echo "==================================================="
echo "✓ Backup Complete"
echo "==================================================="
