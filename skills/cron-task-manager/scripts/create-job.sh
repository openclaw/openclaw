#!/bin/bash
# Create a cron job with validation

set -e

NAME="$1"
TIME="$2"
MESSAGE="$3"
CHANNEL="${4:-feishu}"
TO="${5:-ou_88870bf0a161918c7bb9a36eb5df18af}"
SESSION="${6:-isolated}"
DELETE_AFTER="${7:-true}"

if [ -z "$NAME" ] || [ -z "$TIME" ] || [ -z "$MESSAGE" ]; then
    echo "Usage: $0 <name> <time> <message> [channel] [to] [session] [delete_after]"
    exit 1
fi

# Build command
CMD="openclaw cron add --name \"$NAME\" --at \"$TIME\" --message \"$MESSAGE\" --channel $CHANNEL --to \"$TO\" --session $SESSION"

if [ "$DELETE_AFTER" = "true" ]; then
    CMD="$CMD --delete-after-run"
fi

echo "Creating cron job..."
eval $CMD
