#!/bin/bash
# Backup OpenClaw configuration and data
# Creates timestamped backup archive

BACKUP_DIR="${HOME}/openclaw-backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/openclaw-backup-${TIMESTAMP}.tar.gz"

echo "💾 OpenClaw Backup Utility"
echo "=========================="
echo ""

# Create backup directory
mkdir -p "$BACKUP_DIR"

echo "📦 Creating backup..."
echo "   Source: ~/.openclaw"
echo "   Destination: $BACKUP_FILE"
echo ""

# Check if openclaw directory exists
if [ ! -d ~/.openclaw ]; then
    echo "❌ Error: ~/.openclaw directory not found"
    exit 1
fi

# Create backup with progress
cd ~
tar -czf "$BACKUP_FILE" \
    --exclude=".openclaw/logs/*" \
    --exclude=".openclaw/node_modules/*" \
    --exclude=".openclaw/*/node_modules/*" \
    .openclaw/

BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "   ✅ Backup created: $BACKUP_SIZE"
echo ""

# Show backup contents summary
echo "📋 Backup includes:"
tar -tzf "$BACKUP_FILE" | head -10 | sed 's/^/   - /'
TOTAL_FILES=$(tar -tzf "$BACKUP_FILE" | wc -l)
echo "   ... ($TOTAL_FILES files total)"
echo ""

# List recent backups
echo "📂 Recent backups:"
ls -lh "$BACKUP_DIR" | tail -5 | awk '{print "   "$9" ("$5")"}'
echo ""

# Cleanup old backups (keep last 10)
BACKUP_COUNT=$(ls -1 "$BACKUP_DIR" | wc -l)
if [ $BACKUP_COUNT -gt 10 ]; then
    echo "🗑️  Cleaning up old backups (keeping last 10)..."
    cd "$BACKUP_DIR"
    ls -t openclaw-backup-*.tar.gz | tail -n +11 | xargs rm -f
    echo "   ✅ Cleanup complete"
    echo ""
fi

echo "✅ Backup complete!"
echo ""
echo "📝 To restore this backup:"
echo "   1. Stop gateway: systemctl --user stop openclaw-gateway.service"
echo "   2. Restore: tar -xzf $BACKUP_FILE -C ~"
echo "   3. Start gateway: systemctl --user start openclaw-gateway.service"
echo ""
echo "💡 Tip: Store backups offsite for disaster recovery"
