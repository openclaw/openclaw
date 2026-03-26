#!/bin/bash
set -e

WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-./workspace}"
ARTIFACTS_DIR="${OPENCLAW_ARTIFACTS_DIR:-./artifacts}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="$ARTIFACTS_DIR/workspace_backup_$TIMESTAMP.tar.gz"

echo "Creating workspace snapshot..."
tar -czf "$BACKUP_FILE" "$WORKSPACE_DIR"
echo "Workspace backed up to $BACKUP_FILE"
