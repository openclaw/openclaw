#!/bin/bash
# Check reminders and output due ones (to be sent by the agent)

REMINDERS_FILE="/home/julian/clawd/reminders.md"
NOW_EPOCH=$(date +%s)

# Exit if no reminders file
[[ ! -f "$REMINDERS_FILE" ]] && exit 0

DUE_REMINDERS=()

# Process each unchecked reminder
while IFS= read -r line; do
    # Extract: "- [ ] 2026-01-06 14:30 | Pay for Gumroad"
    datetime=$(echo "$line" | sed -n 's/^- \[ \] \(.*\) | .*/\1/p')
    message=$(echo "$line" | sed -n 's/^- \[ \] .* | \(.*\)/\1/p')
    
    # Skip if parsing failed
    [[ -z "$datetime" ]] || [[ -z "$message" ]] && continue
    
    # Handle shortcuts
    datetime=$(echo "$datetime" | sed "s/^today/$(date '+%Y-%m-%d')/")
    datetime=$(echo "$datetime" | sed "s/^tomorrow/$(date -d 'tomorrow' '+%Y-%m-%d')/")
    
    # Add default time if missing
    if ! echo "$datetime" | grep -q ":"; then
        datetime="$datetime 09:00"
    fi
    
    # Parse to epoch
    reminder_epoch=$(date -d "$datetime" +%s 2>/dev/null)
    
    # Skip if date parsing failed
    [[ -z "$reminder_epoch" ]] && continue
    
    # Check if due
    if [[ $NOW_EPOCH -ge $reminder_epoch ]]; then
        DUE_REMINDERS+=("$message")
        # Mark as done by replacing [ ] with [x]
        escaped_datetime=$(echo "$datetime" | sed 's/[]\/$*.^[]/\\&/g')
        escaped_message=$(echo "$message" | sed 's/[]\/$*.^[]/\\&/g')
        sed -i "s/^- \[ \] $escaped_datetime | $escaped_message$/- [x] $escaped_datetime | $escaped_message/" "$REMINDERS_FILE"
    fi
done < <(grep "^- \[ \]" "$REMINDERS_FILE")

# Output due reminders
if [[ ${#DUE_REMINDERS[@]} -gt 0 ]]; then
    for reminder in "${DUE_REMINDERS[@]}"; do
        echo "⏰ $reminder"
    done
fi

# Clean up reminders older than 24 hours
while IFS= read -r line; do
    datetime=$(echo "$line" | sed -n 's/^- \[x\] \(.*\) | .*/\1/p')
    reminder_epoch=$(date -d "$datetime" +%s 2>/dev/null)
    [[ -z "$reminder_epoch" ]] && continue
    
    age_hours=$(( (NOW_EPOCH - reminder_epoch) / 3600 ))
    if [[ $age_hours -gt 24 ]]; then
        # Delete old completed reminders
        escaped_line=$(echo "$line" | sed 's/[\/&]/\\&/g')
        sed -i "/^${escaped_line}$/d" "$REMINDERS_FILE"
    fi
done < <(grep "^- \[x\]" "$REMINDERS_FILE")
