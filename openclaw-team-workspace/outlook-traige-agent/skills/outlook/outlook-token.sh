#!/bin/bash
# Outlook Token Manager
# Usage: outlook-token.sh [refresh|get|test]

CONFIG_DIR="$HOME/.outlook-mcp"
CONFIG_FILE="$CONFIG_DIR/config.json"
CREDS_FILE="$CONFIG_DIR/credentials.json"

# Check if config exists
if [ ! -f "$CONFIG_FILE" ] || [ ! -f "$CREDS_FILE" ]; then
    echo "Error: Outlook not configured. Run setup first."
    echo "Missing: $CONFIG_FILE or $CREDS_FILE"
    exit 1
fi

# Load credentials
CLIENT_ID=$(jq -r '.client_id' "$CONFIG_FILE")
CLIENT_SECRET=$(jq -r '.client_secret' "$CONFIG_FILE")
ACCESS_TOKEN=$(jq -r '.access_token' "$CREDS_FILE")
REFRESH_TOKEN=$(jq -r '.refresh_token' "$CREDS_FILE")

case "$1" in
    refresh)
        echo "Refreshing token..."
        RESPONSE=$(curl -s -X POST "https://login.microsoftonline.com/common/oauth2/v2.0/token" \
            -H "Content-Type: application/x-www-form-urlencoded" \
            -d "client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&refresh_token=$REFRESH_TOKEN&grant_type=refresh_token&scope=https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.ReadWrite offline_access")
        
        if echo "$RESPONSE" | jq -e '.access_token' > /dev/null 2>&1; then
            echo "$RESPONSE" > "$CREDS_FILE"
            echo "Token refreshed successfully"
        else
            echo "Error refreshing token:"
            echo "$RESPONSE" | jq '.error_description // .'
            exit 1
        fi
        ;;
    
    get)
        echo "$ACCESS_TOKEN"
        ;;
    
    test)
        echo "Testing connection..."
        RESULT=$(curl -s "https://graph.microsoft.com/v1.0/me/mailFolders/inbox" \
            -H "Authorization: Bearer $ACCESS_TOKEN")
        
        if echo "$RESULT" | jq -e '.totalItemCount' > /dev/null 2>&1; then
            TOTAL=$(echo "$RESULT" | jq '.totalItemCount')
            UNREAD=$(echo "$RESULT" | jq '.unreadItemCount')
            echo "✓ Connected! Inbox: $TOTAL emails ($UNREAD unread)"
        else
            echo "✗ Connection failed. Try: outlook-token.sh refresh"
            echo "$RESULT" | jq '.error.message // .'
            exit 1
        fi
        ;;
    
    *)
        echo "Usage: outlook-token.sh [refresh|get|test]"
        echo "  refresh - Refresh the access token"
        echo "  get     - Print current access token"
        echo "  test    - Test the connection"
        ;;
esac
