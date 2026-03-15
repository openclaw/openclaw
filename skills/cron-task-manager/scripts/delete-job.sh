#!/bin/bash
# Delete a cron job by ID or name

TARGET="$1"

if [ -z "$TARGET" ]; then
    echo "Usage: $0 <job-id-or-name>"
    exit 1
fi

# Check if it's an ID (UUID format) or name
if echo "$TARGET" | grep -qE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
    # It's a UUID
    JOB_ID="$TARGET"
else
    # It's a name, find the ID
    JOB_ID=$(openclaw cron list 2>/dev/null | grep "$TARGET" | awk '{print $1}' | head -1)
    if [ -z "$JOB_ID" ]; then
        echo "❌ 未找到名为 '$TARGET' 的任务"
        exit 1
    fi
fi

echo "正在删除任务 $JOB_ID..."
openclaw cron rm "$JOB_ID"
echo "✅ 已删除"
