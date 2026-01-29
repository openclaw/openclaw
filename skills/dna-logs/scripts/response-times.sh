#!/bin/bash
# Calculate response times from clawdbot journal logs
# Usage: response-times.sh [count]

COUNT=${1:-10}

echo "=== Last $COUNT Response Times ==="
echo ""

journalctl --user -u clawdbot-gateway.service --no-pager --since "2 hours ago" 2>/dev/null | \
grep -E "session state.*run_(started|completed)" | \
tail -$((COUNT * 2)) | \
awk '
BEGIN { start_time = 0; session = "" }
/run_started/ {
    match($0, /sessionId=[^ ]+/)
    session = substr($0, RSTART+10, 36)
    match($0, /[0-9]{2}:[0-9]{2}:[0-9]{2}/)
    time_str = substr($0, RSTART, RLENGTH)
    split(time_str, t, ":")
    start_time = t[1]*3600 + t[2]*60 + t[3]
    start_full = time_str
}
/run_completed/ {
    match($0, /[0-9]{2}:[0-9]{2}:[0-9]{2}/)
    time_str = substr($0, RSTART, RLENGTH)
    split(time_str, t, ":")
    end_time = t[1]*3600 + t[2]*60 + t[3]
    if (start_time > 0) {
        duration = end_time - start_time
        if (duration < 0) duration += 86400  # handle day wrap
        if (duration > 60) {
            printf "%s -> %s: %dm %ds", start_full, time_str, int(duration/60), duration%60
            if (duration > 30) printf " [SLOW]"
            printf "\n"
        } else {
            printf "%s -> %s: %ds", start_full, time_str, duration
            if (duration > 30) printf " [SLOW]"
            printf "\n"
        }
    }
    start_time = 0
}
' | tail -$COUNT

echo ""
echo "=== Summary ==="
journalctl --user -u clawdbot-gateway.service --no-pager --since "1 hour ago" 2>/dev/null | \
grep -c "run_completed" | xargs -I{} echo "Completed runs (1h): {}"

journalctl --user -u clawdbot-gateway.service --no-pager --since "1 hour ago" 2>/dev/null | \
grep -iE "(error|fail)" | wc -l | xargs -I{} echo "Errors (1h): {}"
