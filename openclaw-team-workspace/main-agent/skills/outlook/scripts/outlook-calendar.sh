#!/bin/bash
# Outlook Calendar Operations
# Usage: outlook-calendar.sh <command> [args]

CONFIG_DIR="$HOME/.outlook-mcp"
CREDS_FILE="$CONFIG_DIR/credentials.json"
CONFIG_FILE="$CONFIG_DIR/config.json"

# Load token
ACCESS_TOKEN=$(jq -r '.access_token' "$CREDS_FILE" 2>/dev/null)

if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" = "null" ]; then
    echo "Error: No access token. Run setup first."
    exit 1
fi

API="https://graph.microsoft.com/v1.0/me"

normalize_dt() {
    case "$1" in
        *:??:??) printf '%s' "$1" ;;
        *) printf '%s:00' "$1" ;;
    esac
}

get_timezone() {
    TZ_VALUE=$(jq -r '.timezone_microsoft // .timezone // empty' "$CONFIG_FILE" 2>/dev/null)
    if [ -z "$TZ_VALUE" ] || [ "$TZ_VALUE" = "null" ]; then
        printf '%s' "UTC"
    else
        printf '%s' "$TZ_VALUE"
    fi
}

case "$1" in
    events)
        COUNT=${2:-10}
        OFFSET=$(date +"%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)/\1:\2/')
        OFFSET_ENCODED="${OFFSET/+/%2B}"

        NOW="$(date +"%Y-%m-%dT%H:%M:%S")${OFFSET_ENCODED}"
        END="$(date -d '+1 year' +"%Y-%m-%dT23:59:59")${OFFSET_ENCODED}"
        TIMEZONE=$(get_timezone)

        curl -s "$API/calendarView?startDateTime=${NOW}&endDateTime=${END}&\$top=$COUNT&\$orderby=start/dateTime&\$select=id,subject,start,end,location,isAllDay" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Prefer: outlook.timezone=\"$TIMEZONE\"" \
            | jq 'if .value then (.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, start: .value.start.dateTime[0:16], end: .value.end.dateTime[0:16], location: (.value.location.displayName // ""), id: .value.id[-20:]}) else {error: .error.message} end'
        ;;

    today)
        OFFSET=$(date +"%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)/\1:\2/')
        OFFSET_ENCODED="${OFFSET/+/%2B}"
        TODAY_START="$(date -d 'today 00:00:00' +"%Y-%m-%dT00:00:00")${OFFSET_ENCODED}"
        TODAY_END="$(date -d 'today 23:59:59' +"%Y-%m-%dT23:59:59")${OFFSET_ENCODED}"
        TIMEZONE=$(get_timezone)

        curl -s "$API/calendarView?startDateTime=${TODAY_START}&endDateTime=${TODAY_END}&\$orderby=start/dateTime&\$select=id,subject,start,end,location" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Prefer: outlook.timezone=\"$TIMEZONE\"" \
            | jq 'if .value then (.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, start: .value.start.dateTime[0:16], end: .value.end.dateTime[0:16], location: (.value.location.displayName // ""), id: .value.id[-20:]}) else {error: .error.message} end'
        ;;

    week)
        WEEK_START=$(date -d "today 00:00:00" +"%Y-%m-%dT00:00:00")
        WEEK_END=$(date -d "+7 days 23:59:59" +"%Y-%m-%dT23:59:59")
        TIMEZONE=$(get_timezone)

        curl -s "$API/calendarView?startDateTime=${WEEK_START}&endDateTime=${WEEK_END}&\$orderby=start/dateTime&\$select=id,subject,start,end,location,isAllDay" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Prefer: outlook.timezone=\"$TIMEZONE\"" \
            | jq 'if .value then (.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, start: .value.start.dateTime[0:16], end: .value.end.dateTime[0:16], location: (.value.location.displayName // ""), id: .value.id[-20:]}) else {error: .error.message} end'
        ;;

    read)
        EVENT_ID="${2:-}"
        TIMEZONE=$(get_timezone)

        if [ -z "$EVENT_ID" ]; then
            echo "Usage: outlook-calendar.sh read <id>"
            exit 1
        fi

        FULL_ID=$(curl -s "$API/calendar/events?\$top=50&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            | jq -r ".value[]? | select(.id | endswith(\"$EVENT_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then
            echo "Event not found"
            exit 1
        fi

        curl -s "$API/calendar/events/$FULL_ID" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Prefer: outlook.timezone=\"$TIMEZONE\"" \
            | jq 'if .error then .error else {
                subject,
                start: .start.dateTime,
                end: .end.dateTime,
                location: .location.displayName,
                body: (if .body.contentType == "html" then (.body.content | gsub("<[^>]*>"; "") | gsub("\\s+"; " ")[0:500]) else .body.content[0:500] end),
                attendees: [.attendees[]?.emailAddress.address],
                isOnline: .isOnlineMeeting,
                link: .onlineMeeting.joinUrl
            } end'
        ;;

    create)
        # Create event:
        # outlook-calendar.sh create "Subject" "2026-01-26T10:00" "2026-01-26T11:00" "attendee1@email.com,attendee2@email.com" [location]
        SUBJECT="${2:-}"
        START="${3:-}"
        END="${4:-}"
        ATTENDEES="${5:-}"
        LOCATION="${6:-}"
        TIMEZONE=$(get_timezone)

        if [ -z "$SUBJECT" ] || [ -z "$START" ] || [ -z "$END" ]; then
            echo "Usage: outlook-calendar.sh create <subject> <start> <end> <attendees> [location]"
            echo "Date format: YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS"
            echo 'Attendees: comma-separated emails, append :optional for optional attendees, e.g. a@b.com,c@d.com:optional'
            exit 1
        fi

        START_NORM=$(normalize_dt "$START")
        END_NORM=$(normalize_dt "$END")

        ATTENDEES_JSON="[]"
        if [ -n "$ATTENDEES" ]; then
            ATTENDEES_JSON=$(printf '%s' "$ATTENDEES" | tr ',' '\n' | jq -Rsc '
                split("\n") | map(select(length > 0)) |
                map(
                    if contains(":optional") then
                        {"emailAddress": {"address": (split(":optional")[0])}, "type": "optional"}
                    else
                        {"emailAddress": {"address": (split(":required")[0])}, "type": "required"}
                    end
                )
            ')
        fi

        EVENT_DATA=$(jq -n \
            --arg subject "$SUBJECT" \
            --arg start "$START_NORM" \
            --arg end_time "$END_NORM" \
            --arg timezone "$TIMEZONE" \
            --arg location "$LOCATION" \
            --argjson attendees "$ATTENDEES_JSON" \
            '{
                "subject": $subject,
                "start": {"dateTime": $start, "timeZone": $timezone},
                "end": {"dateTime": $end_time, "timeZone": $timezone}
            }
            + (if $location != "" then {"location": {"displayName": $location}} else {} end)
            + (if ($attendees | length) > 0 then {"attendees": $attendees} else {} end)')

        curl -s -X POST "$API/calendar/events" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$EVENT_DATA" \
            | jq 'if .error then .error else {status: "event created", subject: .subject, start: .start.dateTime, end: .end.dateTime, id: .id[-20:]} end'
        ;;

    cancel)
        EVENT_ID="${2:-}"

        if [ -z "$EVENT_ID" ]; then
            echo "Usage: outlook-calendar.sh cancel <id>"
            exit 1
        fi

        FULL_ID=$(curl -s "$API/calendar/events?\$top=50&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            | jq -r ".value[]? | select(.id | endswith(\"$EVENT_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then
            echo "Event not found"
            exit 1
        fi

        RESULT=$(curl -s -w "\n%{http_code}" -X POST "$API/calendar/events/$FULL_ID/cancel" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{"comment": "This meeting has been cancelled."}')

        HTTP_CODE=$(echo "$RESULT" | tail -1)
        if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "202" ] || [ "$HTTP_CODE" = "204" ]; then
            echo "{\"status\": \"event cancelled\", \"id\": \"$EVENT_ID\"}"
        else
            echo "$RESULT" | head -n -1 | jq '.error // .'
            exit 1
        fi
        ;;

    update)
        EVENT_ID="${2:-}"
        TIMEZONE=$(get_timezone)

        if [ -z "$EVENT_ID" ]; then
            echo "Usage: outlook-calendar.sh update <id> [subject=val] [location=val] [start=val] [end=val] [body=val] [attendees=email1,email2]"
            exit 1
        fi

        shift 2

        if [ $# -eq 0 ]; then
            echo "Usage: outlook-calendar.sh update <id> [subject=val] [location=val] [start=val] [end=val] [body=val] [attendees=email1,email2]"
            exit 1
        fi

        FULL_ID=$(curl -s "$API/calendar/events?\$top=50&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            | jq -r ".value[]? | select(.id | endswith(\"$EVENT_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then
            echo "Event not found"
            exit 1
        fi

        BODY=$(jq -n '{}')

        for ARG in "$@"; do
            KEY="${ARG%%=*}"
            VAL="${ARG#*=}"

            case "$KEY" in
                subject)
                    BODY=$(echo "$BODY" | jq --arg v "$VAL" '. + {"subject": $v}')
                    ;;
                location)
                    BODY=$(echo "$BODY" | jq --arg v "$VAL" '. + {"location": {"displayName": $v}}')
                    ;;
                start)
                    VAL_NORM=$(normalize_dt "$VAL")
                    BODY=$(echo "$BODY" | jq --arg v "$VAL_NORM" --arg tz "$TIMEZONE" '. + {"start": {"dateTime": $v, "timeZone": $tz}}')
                    ;;
                end)
                    VAL_NORM=$(normalize_dt "$VAL")
                    BODY=$(echo "$BODY" | jq --arg v "$VAL_NORM" --arg tz "$TIMEZONE" '. + {"end": {"dateTime": $v, "timeZone": $tz}}')
                    ;;
                body)
                    BODY=$(echo "$BODY" | jq --arg v "$VAL" '. + {"body": {"contentType": "HTML", "content": $v}}')
                    ;;
                attendees)
                    ATTENDEES_JSON=$(printf '%s' "$VAL" | tr ',' '\n' | jq -Rsc '
                        split("\n") | map(select(length > 0)) |
                        map(
                            if contains(":optional") then
                                {"emailAddress": {"address": (split(":optional")[0])}, "type": "optional"}
                            else
                                {"emailAddress": {"address": (split(":required")[0])}, "type": "required"}
                            end
                        )
                    ')
                    BODY=$(echo "$BODY" | jq --argjson a "$ATTENDEES_JSON" '. + {"attendees": $a}')
                    ;;
                *)
                    echo "Unknown field: $KEY"
                    exit 1
                    ;;
            esac
        done

        curl -s -X PATCH "$API/calendar/events/$FULL_ID" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$BODY" \
            | jq 'if .error then .error else {status: "event updated", subject: .subject, id: .id[-20:]} end'
        ;;

    calendars)
        curl -s "$API/calendars" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            | jq 'if .value then (.value[] | {name: .name, color: .color, canEdit: .canEdit, id: .id[-20:]}) else {error: .error.message} end'
        ;;

    availability)
        EMAIL="${2:-}"
        DATE="${3:-$(date +%Y-%m-%d)}"

        if [ -z "$EMAIL" ]; then
            echo "Usage: outlook-calendar.sh availability <email> [date YYYY-MM-DD]"
            exit 1
        fi

        START="${DATE}T00:00:00"
        END="${DATE}T23:59:59"
        TIMEZONE=$(get_timezone)

        curl -s -X POST "https://graph.microsoft.com/v1.0/me/calendar/getschedule" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Prefer: outlook.timezone=\"$TIMEZONE\"" \
            -H "Content-Type: application/json" \
            -d "$(jq -n \
                --arg email "$EMAIL" \
                --arg start "$START" \
                --arg end_time "$END" \
                --arg tz "$TIMEZONE" \
                '{
                    "schedules": [$email],
                    "startTime": {"dateTime": $start, "timeZone": $tz},
                    "endTime": {"dateTime": $end_time, "timeZone": $tz},
                    "availabilityViewInterval": 30
                }')" \
            | jq --arg tz "$TIMEZONE" 'if .error then .error else {
                email: .value[0].scheduleId,
                busySlots: [.value[0].scheduleItems[]? | select(.status != "free") | {
                    status: .status,
                    start: .start.dateTime,
                    end: .end.dateTime,
                    subject: .subject,
                    timezone: $tz
                }]
            } end'
        ;;

    *)
        echo "Usage: outlook-calendar.sh <command> [args]"
        echo ""
        echo "VIEW:"
        echo "  events [count]                 - List upcoming events"
        echo "  today                          - Today's events"
        echo "  week                           - This week's events"
        echo "  read <id>                      - Event details"
        echo "  calendars                      - List all calendars"
        echo "  availability <email> [date]    - Check person's calendar availability, default date is today"
        echo ""
        echo "CREATE:"
        echo '  create <subj> <start> <end> <attendees> [location] - Create event'
        echo '  attendees: comma-separated emails, append :optional for optional attendees, e.g. a@b.com,c@d.com:optional'
        echo ""
        echo "MANAGE:"
        echo "  update <id> [subject=val] [location=val] [start=val] [end=val] [body=val] [attendees=emails] - Update event fields"
        echo "  cancel <id>                    - Cancel event, sends cancellation to attendees"
        echo ""
        echo "Date format: YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS"
        ;;
esac
