#!/bin/bash
# Create a recurring reminder
# Usage: create-recurring.sh "message" "schedule"

MESSAGE="$1"
SCHEDULE="$2"
REMINDERS_FILE="/home/julian/clawd/reminders.md"
TIMEZONE="Europe/Warsaw"

[[ -z "$MESSAGE" ]] && echo "Error: No message provided" && exit 1
[[ -z "$SCHEDULE" ]] && echo "Error: No schedule provided" && exit 1

# Parse schedule to cron expression or duration
parse_schedule() {
    local input="$1"
    
    # Every X minutes/hours
    if [[ "$input" =~ every[[:space:]]+([0-9]+)[[:space:]]+(minute|hour)s? ]]; then
        local amount="${BASH_REMATCH[1]}"
        local unit="${BASH_REMATCH[2]}"
        case "$unit" in
            minute) echo "duration:$((amount))m" ;;
            hour) echo "duration:$((amount))h" ;;
        esac
        return
    fi
    
    # Daily at specific time
    if [[ "$input" =~ (daily|every[[:space:]]+day)[[:space:]]+at[[:space:]]+([0-9]{1,2})(:[0-9]{2})?(am|pm)? ]]; then
        local hour="${BASH_REMATCH[2]}"
        local minute="${BASH_REMATCH[3]:-:00}"
        local ampm="${BASH_REMATCH[4]}"
        minute="${minute#:}"
        
        # Convert to 24h if needed
        if [[ "$ampm" == "pm" ]] && [[ $hour -lt 12 ]]; then
            hour=$((hour + 12))
        elif [[ "$ampm" == "am" ]] && [[ $hour -eq 12 ]]; then
            hour=0
        fi
        
        # Cron: minute hour * * *
        echo "cron:$minute $hour * * *"
        return
    fi
    
    # Weekday at time (e.g., "every Monday at 2pm")
    if [[ "$input" =~ every[[:space:]]+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[[:space:]]+at[[:space:]]+([0-9]{1,2})(:[0-9]{2})?(am|pm)? ]]; then
        local day="${BASH_REMATCH[1]}"
        local hour="${BASH_REMATCH[2]}"
        local minute="${BASH_REMATCH[3]:-:00}"
        local ampm="${BASH_REMATCH[4]}"
        minute="${minute#:}"
        
        # Convert to 24h if needed
        if [[ "$ampm" == "pm" ]] && [[ $hour -lt 12 ]]; then
            hour=$((hour + 12))
        elif [[ "$ampm" == "am" ]] && [[ $hour -eq 12 ]]; then
            hour=0
        fi
        
        # Convert day to cron day-of-week (0=Sunday)
        local dow
        case "$day" in
            Sunday) dow=0 ;;
            Monday) dow=1 ;;
            Tuesday) dow=2 ;;
            Wednesday) dow=3 ;;
            Thursday) dow=4 ;;
            Friday) dow=5 ;;
            Saturday) dow=6 ;;
        esac
        
        # Cron: minute hour * * day-of-week
        echo "cron:$minute $hour * * $dow"
        return
    fi
    
    # Weekly (defaults to Monday 9am)
    if [[ "$input" =~ ^weekly$ ]]; then
        echo "cron:0 9 * * 1"
        return
    fi
    
    echo "error"
}

# Parse the schedule
PARSED=$(parse_schedule "$SCHEDULE")
if [[ "$PARSED" == "error" ]]; then
    echo "Error: Could not parse schedule: $SCHEDULE"
    exit 1
fi

# Build cron command based on type
if [[ "$PARSED" =~ ^duration:(.+)$ ]]; then
    DURATION="${BASH_REMATCH[1]}"
    cd /home/julian/clawdbot
    JOB_OUTPUT=$(npx tsx src/index.ts cron add \
        --name "Recurring: $MESSAGE" \
        --every "$DURATION" \
        --session isolated \
        --wake now \
        --message "⏰ $MESSAGE" \
        --deliver \
        --channel telegram \
        --to 6636746252 \
        --json 2>&1)
    SCHEDULE_DISPLAY="every $DURATION"
elif [[ "$PARSED" =~ ^cron:(.+)$ ]]; then
    CRON_EXPR="${BASH_REMATCH[1]}"
    cd /home/julian/clawdbot
    JOB_OUTPUT=$(npx tsx src/index.ts cron add \
        --name "Recurring: $MESSAGE" \
        --cron "$CRON_EXPR" \
        --tz "$TIMEZONE" \
        --session isolated \
        --wake now \
        --message "⏰ $MESSAGE" \
        --deliver \
        --channel telegram \
        --to 6636746252 \
        --json 2>&1)
    SCHEDULE_DISPLAY="cron: $CRON_EXPR"
fi

if [[ $? -ne 0 ]]; then
    echo "Error creating cron job: $JOB_OUTPUT"
    exit 1
fi

# Extract JSON from output
JSON_OUTPUT=$(echo "$JOB_OUTPUT" | grep -A100 "^{" | grep -B100 "^}")
JOB_ID=$(echo "$JSON_OUTPUT" | jq -r '.id' 2>/dev/null)

# Log to markdown
mkdir -p "$(dirname "$REMINDERS_FILE")"
echo "- [recurring] $SCHEDULE_DISPLAY | $MESSAGE (id: $JOB_ID)" >> "$REMINDERS_FILE"

echo "✅ Recurring reminder set: $SCHEDULE_DISPLAY"
echo "📝 Logged to $REMINDERS_FILE"
echo "🆔 Job ID: $JOB_ID"
