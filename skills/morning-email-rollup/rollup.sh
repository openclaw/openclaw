#!/bin/bash
# Morning Email Rollup - Important emails from the last 24 hours

set -uo pipefail

GOG_ACCOUNT="${GOG_ACCOUNT:-your-email@gmail.com}"
MAX_EMAILS="${MAX_EMAILS:-10}"  # Default to 10, can be overridden via environment variable
WORKSPACE="${CLAWDBOT_WORKSPACE:-$HOME/clawd}"
LOG_FILE="${WORKSPACE}/morning-email-rollup-log.md"

# Initialize log
mkdir -p "$(dirname "$LOG_FILE")"

# Log with timestamp
log() {
    echo "- [$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

echo "📧 **Morning Email Rollup** - $(date '+%A, %B %d, %Y')"
echo ""

log "🔄 Starting morning email rollup"

# Check for calendar events (gog) - graceful fallback if not installed
if command -v gog &> /dev/null; then
    TODAY=$(date '+%Y-%m-%d')
    TOMORROW=$(date -d "$TODAY + 1 day" '+%Y-%m-%d')
    CALENDAR_EVENTS=$(gog calendar events primary --from "$TODAY" --to "$TOMORROW" --account "$GOG_ACCOUNT" 2>/dev/null)

    # Check if there are events (more than just the header line)
    EVENT_COUNT=$(echo "$CALENDAR_EVENTS" | tail -n +2 | grep -c . || echo "0")

    if [[ "$EVENT_COUNT" -gt 0 ]]; then
        echo "📅 **$EVENT_COUNT calendar event(s) today**"

        # Parse and format events (skip header line)
        echo "$CALENDAR_EVENTS" | tail -n +2 | while IFS= read -r line; do
            [[ -z "$line" ]] && continue

            # Parse gog output: ID START END SUMMARY
            start_full=$(echo "$line" | awk '{print $2}')
            end_full=$(echo "$line" | awk '{print $3}')
            title=$(echo "$line" | awk '{$1=$2=$3=""; print $0}' | sed 's/^[[:space:]]*//')

            # Extract time from ISO format (e.g., 2026-01-15T05:00:00-07:00)
            start_time=$(echo "$start_full" | cut -d'T' -f2 | cut -d'-' -f1 | cut -d'+' -f1 | cut -d':' -f1-2)
            end_time=$(echo "$end_full" | cut -d'T' -f2 | cut -d'-' -f1 | cut -d'+' -f1 | cut -d':' -f1-2)

            # Convert to 12-hour format
            start_12h=$(date -d "$start_time" '+%I:%M %p' 2>/dev/null | sed 's/^0//' | sed 's/:00//')
            end_12h=$(date -d "$end_time" '+%I:%M %p' 2>/dev/null | sed 's/^0//' | sed 's/:00//')

            echo "• $title - $start_12h to $end_12h"
        done
        echo ""
        log "📅 Calendar events listed ($EVENT_COUNT events)"
    fi
fi

echo ""

# Search for important/starred emails from last 24 hours
IMPORTANT_EMAILS=$(gog gmail search 'is:important OR is:starred newer_than:1d' --max 20 --account "$GOG_ACCOUNT" --json 2>/dev/null)

if [[ -z "$IMPORTANT_EMAILS" ]] || [[ "$IMPORTANT_EMAILS" == "null" ]]; then
    echo "✅ No important emails in the last 24 hours."
    log "✅ No important emails found"
    exit 0
fi

# Count emails
EMAIL_COUNT=$(echo "$IMPORTANT_EMAILS" | jq -r '.threads | length' 2>/dev/null || echo "0")

if [[ "$EMAIL_COUNT" -eq 0 ]]; then
    echo "✅ No important emails in the last 24 hours."
    log "✅ No important emails found"
    exit 0
fi

echo "📧 **$EMAIL_COUNT important email(s) from last 24 hours**"
if [[ $EMAIL_COUNT -gt $MAX_EMAILS ]]; then
    echo "(Showing top $MAX_EMAILS)"
fi
echo ""

# Function to summarize email using gemini
summarize_email() {
    local body="$1"

    # Check if gemini is available
    if ! command -v gemini &> /dev/null; then
        # Fallback: clean and return first readable sentence if gemini not available
        echo "$body" | sed 's/<[^>]*>//g' | sed 's/&[a-z]*;//g' | tr -s ' ' | sed 's/^ *//' | sed 's/\./.\n/g' | head -1 | head -c 150
        return
    fi

    # Use gemini to get a 1-sentence summary
    # Filter out "Loaded cached credentials" line
    local summary
    summary=$(echo "$body" | gemini --model gemini-2.0-flash "Summarize this email in exactly 1 sentence of natural language. Make it medium to long length. Don't use quotes:" 2>&1 | grep -v "Loaded cached" | tail -1)

    # Clean up the summary (remove any newlines, extra spaces)
    summary=$(echo "$summary" | tr -s ' ' | sed 's/^ *//' | sed 's/ *$//' | head -1)

    # If gemini failed or returned empty, return cleaned body snippet
    if [[ -z "$summary" ]] || [[ ${#summary} -lt 10 ]]; then
        echo "$body" | sed 's/<[^>]*>//g' | sed 's/&[a-z]*;//g' | tr -s ' ' | sed 's/^ *//' | head -c 200
    else
        echo "$summary"
    fi
}

# Process up to MAX_EMAILS
email_counter=0
echo "$IMPORTANT_EMAILS" | jq -r '.threads[] | "\(.id)"' | while IFS= read -r thread_id; do
    [[ -z "$thread_id" ]] && continue

    # Limit to MAX_EMAILS
    if [[ $email_counter -ge $MAX_EMAILS ]]; then
        break
    fi
    email_counter=$((email_counter + 1))

    # Get email details
    email_data=$(gog gmail get "$thread_id" --account "$GOG_ACCOUNT" 2>/dev/null)

    if [[ -z "$email_data" ]]; then
        continue
    fi

    # Extract fields
    from=$(echo "$email_data" | grep "^from" | cut -f2-)
    subject=$(echo "$email_data" | grep "^subject" | cut -f2-)

    # Get sender name only (strip email address)
    sender_name=$(echo "$from" | sed 's/<.*>//' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
    if [[ -z "$sender_name" ]]; then
        sender_name="$from"
    fi

    # Get email body (after headers)
    body=$(echo "$email_data" | awk 'BEGIN{body=0} /^$/{body=1; next} body{print}')

    # Clean body - remove HTML/CSS and convert to plain text
    cleaned_body=$(echo "$body" | \
        sed 's/<[^>]*>//g' | \
        sed 's/&nbsp;/ /g' | \
        sed 's/&amp;/\&/g' | \
        sed 's/&lt;/</g' | \
        sed 's/&gt;/>/g' | \
        sed 's/@media[^}]*}//g' | \
        sed 's/{[^}]*}//g' | \
        sed 's/\[[^]]*\]//g' | \
        tr '\n' ' ' | \
        sed 's/\\n/ /g' | \
        sed 's/  */ /g' | \
        sed 's/^ *//' | \
        head -c 5000)

    # Get AI summary
    summary=$(summarize_email "$cleaned_body")

    # Check read/unread status
    labels=$(echo "$email_data" | grep "^label_ids" | cut -f2-)
    if [[ "$labels" == *"UNREAD"* ]]; then
        read_marker="🔴 "
    else
        read_marker="🟢 "
    fi

    echo "${read_marker}**${sender_name}: ${subject}**"
    echo "   $summary"
    echo ""

done

log "✅ Rollup complete: $EMAIL_COUNT emails"
echo ""
echo "---"
echo "💡 **Need more details?** Ask me to read or search specific emails."
