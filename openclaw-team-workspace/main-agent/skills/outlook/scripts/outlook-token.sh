#!/bin/bash
# Outlook Token Manager
# Usage: outlook-token.sh [refresh|get|test|check-expiry]

set -euo pipefail

CONFIG_DIR="$HOME/.outlook-mcp"
CONFIG_FILE="$CONFIG_DIR/config.json"
CREDS_FILE="$CONFIG_DIR/credentials.json"

SCOPES="https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/MailboxSettings.Read https://graph.microsoft.com/User.ReadBasic.All offline_access"

if [ ! -f "$CONFIG_FILE" ] || [ ! -f "$CREDS_FILE" ]; then
    echo "Error: Outlook not configured. Run setup first."
    echo "Missing: $CONFIG_FILE or $CREDS_FILE"
    exit 1
fi

CLIENT_ID="$(jq -r '.client_id // empty' "$CONFIG_FILE")"
CLIENT_SECRET="$(jq -r '.client_secret // empty' "$CONFIG_FILE")"
ACCESS_TOKEN="$(jq -r '.access_token // empty' "$CREDS_FILE")"
REFRESH_TOKEN="$(jq -r '.refresh_token // empty' "$CREDS_FILE")"

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
    echo "Error: config.json is missing client_id or client_secret."
    exit 1
fi

case "${1:-}" in
    refresh)
        if [ -z "$REFRESH_TOKEN" ] || [ "$REFRESH_TOKEN" = "null" ]; then
            echo "Error: credentials.json is missing refresh_token. Re-run setup."
            exit 1
        fi

        echo "Refreshing token..."

        RESPONSE="$(curl -s -X POST "https://login.microsoftonline.com/common/oauth2/v2.0/token" \
            -H "Content-Type: application/x-www-form-urlencoded" \
            --data-urlencode "client_id=$CLIENT_ID" \
            --data-urlencode "client_secret=$CLIENT_SECRET" \
            --data-urlencode "refresh_token=$REFRESH_TOKEN" \
            --data-urlencode "grant_type=refresh_token" \
            --data-urlencode "scope=$SCOPES")"

        if echo "$RESPONSE" | jq -e '.access_token' >/dev/null 2>&1; then
            NOW="$(date +%s)"
            EXPIRES_IN="$(echo "$RESPONSE" | jq -r '.expires_in // 3600')"
            EXPIRES_AT="$((NOW + EXPIRES_IN))"

            # Some refresh responses may omit refresh_token. Preserve old one if needed.
            if ! echo "$RESPONSE" | jq -e '.refresh_token' >/dev/null 2>&1; then
                RESPONSE="$(echo "$RESPONSE" | jq --arg rt "$REFRESH_TOKEN" '. + {"refresh_token": $rt}')"
            fi

            echo "$RESPONSE" | jq --argjson exp "$EXPIRES_AT" '. + {"expires_at": $exp}' > "$CREDS_FILE"
            chmod 600 "$CREDS_FILE"

            echo "Token refreshed successfully"

            NEW_TOKEN="$(jq -r '.access_token' "$CREDS_FILE")"
            TIMEZONE_MICROSOFT="$(curl -s "https://graph.microsoft.com/v1.0/me/mailboxSettings/timeZone" \
                -H "Authorization: Bearer $NEW_TOKEN" | jq -r '.value // empty')"

            if [ -n "$TIMEZONE_MICROSOFT" ] && [ "$TIMEZONE_MICROSOFT" != "null" ]; then
                jq --arg tz "$TIMEZONE_MICROSOFT" '
                    .timezone_microsoft = $tz
                ' "$CONFIG_FILE" > /tmp/outlook-config.json \
                    && mv /tmp/outlook-config.json "$CONFIG_FILE"
                chmod 600 "$CONFIG_FILE"
            fi
        else
            echo "Error refreshing token:"
            echo "$RESPONSE" | jq '.'
            exit 1
        fi
        ;;

    check-expiry)
        EXPIRY="$(jq -r '.expires_at // empty' "$CREDS_FILE")"

        if [ -z "$EXPIRY" ]; then
            echo '{"status": "unknown", "message": "No expires_at info in credentials"}'
            exit 0
        fi

        NOW="$(date +%s)"
        DAYS_LEFT="$(( (EXPIRY - NOW) / 86400 ))"

        if [ "$DAYS_LEFT" -lt 0 ]; then
            echo "{\"status\": \"expired\", \"days_left\": $DAYS_LEFT, \"message\": \"Token expired or expires_at is in the past\"}"
        elif [ "$DAYS_LEFT" -lt 7 ]; then
            echo "{\"status\": \"warning\", \"days_left\": $DAYS_LEFT, \"message\": \"Token expiring soon\"}"
        else
            echo "{\"status\": \"ok\", \"days_left\": $DAYS_LEFT}"
        fi
        ;;

    get)
        if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" = "null" ]; then
            echo "Error: credentials.json is missing access_token. Run setup or refresh."
            exit 1
        fi
        echo "$ACCESS_TOKEN"
        ;;

    test)
        if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" = "null" ]; then
            echo "Error: credentials.json is missing access_token. Run setup or refresh."
            exit 1
        fi

        echo "Testing connection..."

        RESULT="$(curl -s "https://graph.microsoft.com/v1.0/me/mailFolders/inbox" \
            -H "Authorization: Bearer $ACCESS_TOKEN")"

        if echo "$RESULT" | jq -e '.totalItemCount' >/dev/null 2>&1; then
            TOTAL="$(echo "$RESULT" | jq '.totalItemCount')"
            UNREAD="$(echo "$RESULT" | jq '.unreadItemCount')"
            echo "✓ Connected! Inbox: $TOTAL emails ($UNREAD unread)"
        else
            echo "✗ Connection failed. Try: outlook-token.sh refresh"
            echo "$RESULT" | jq '.'
            exit 1
        fi
        ;;

    *)
        echo "Usage: outlook-token.sh [refresh|get|test|check-expiry]"
        echo "  refresh      - Refresh the access token"
        echo "  get          - Print current access token"
        echo "  test         - Test the connection"
        echo "  check-expiry - Check token expiry metadata"
        ;;
esac
