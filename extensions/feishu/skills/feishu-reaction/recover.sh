#!/bin/bash
# Feishu Reaction Feature Recovery Script
# Use this after OpenClaw update if reaction feature stops working

cd ~/openclaw

echo "Recovering feishu reaction feature..."

# Backup current monitor.ts
if [ -f extensions/feishu/src/monitor.ts ]; then
    cp extensions/feishu/src/monitor.ts /tmp/monitor.ts.backup.$(date +%s)
    echo "Backed up current monitor.ts"
fi

# Restore from skill backup
cp extensions/feishu/skills/feishu-reaction/monitor.ts extensions/feishu/src/monitor.ts
echo "Restored monitor.ts from skill backup"

# Restart gateway
openclaw gateway restart
echo "Gateway restarted. Reaction feature should now work."

echo "Done!"