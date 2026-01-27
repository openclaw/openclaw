#!/bin/bash
# Check Steve's email inbox for unread messages
# Outputs: 📬 New email from [sender]: [subject] or nothing (silent)

# Must be run from ~/clawd directory (cron job does: cd ~/clawd && ./personal-scripts/check-email-steve.sh)
cd /Users/steve/clawd

# Email credentials - try env vars first, fall back to reading from moltbot.json
EMAIL="${STEVE_EMAIL:-steve@withagency.ai}"
PASSWORD="${STEVE_EMAIL_PASSWORD}"

# If no password in env, try to read from moltbot.json
if [ -z "$PASSWORD" ]; then
    PASSWORD=$(python3 -c "import json; print(json.load(open('$HOME/.clawdbot/moltbot.json'))['skills']['entries']['steve-email']['env']['STEVE_EMAIL_PASSWORD'])" 2>/dev/null)
fi

if [ -z "$PASSWORD" ]; then
    echo "⚠️ Missing STEVE_EMAIL_PASSWORD" >&2
    exit 1
fi

# Check for unread messages
RESULT=$(uv run skills/purelymail/scripts/purelymail.py inbox \
    --email "$EMAIL" \
    --password "$PASSWORD" \
    --unread \
    --limit 10 2>&1)

# Check for errors
if echo "$RESULT" | grep -q "error\|Error\|CONNECTION\|Connection"; then
    echo "⚠️ Email check failed: $(echo "$RESULT" | head -1)"
    exit 1
fi

# Count unread (use tr to remove any extra whitespace/newlines)
UNREAD_COUNT=$(echo "$RESULT" | grep -c "From:" 2>/dev/null | tr -d '[:space:]')
UNREAD_COUNT=${UNREAD_COUNT:-0}

if [ "$UNREAD_COUNT" -gt 0 ] 2>/dev/null; then
    # Output each unread email
    echo "$RESULT" | grep -E "^(From:|Subject:)" | while read -r line; do
        if [[ "$line" == From:* ]]; then
            SENDER="${line#From: }"
        elif [[ "$line" == Subject:* ]]; then
            SUBJECT="${line#Subject: }"
            echo "📬 New email from $SENDER: $SUBJECT"
        fi
    done
    
    # Mark all as read
    uv run skills/purelymail/scripts/purelymail.py mark-read all \
        --email "$EMAIL" \
        --password "$PASSWORD" >/dev/null 2>&1
fi

# If no unread, output nothing (silent ack)
