#!/data/data/com.termux/files/usr/bin/bash
# DNA OAuth Sync Widget
# Syncs Claude Code tokens to DNA on l36 server
# Place in ~/.shortcuts/ on phone for Termux:Widget

termux-toast "Syncing DNA auth..."

# Run sync on l36 server
RESULT=$(ssh l36 '/home/admin/dna/scripts/sync-claude-code-auth.sh' 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    # Extract expiry time from output
    EXPIRY=$(echo "$RESULT" | grep "Token expires:" | cut -d: -f2-)

    termux-vibrate -d 100
    termux-toast "DNA synced! Expires:${EXPIRY}"

    # Optional: restart dna service
    ssh l36 'systemctl --user restart dna' 2>/dev/null
else
    termux-vibrate -d 300
    termux-toast "Sync failed: ${RESULT}"
fi
