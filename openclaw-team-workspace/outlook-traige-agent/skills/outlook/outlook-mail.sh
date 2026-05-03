#!/bin/bash
# Outlook Mail Operations
# Usage: outlook-mail.sh <command> [args]

CONFIG_DIR="$HOME/.outlook-mcp"
CREDS_FILE="$CONFIG_DIR/credentials.json"

# Load token
ACCESS_TOKEN=$(jq -r '.access_token' "$CREDS_FILE" 2>/dev/null)

if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" = "null" ]; then
    echo "Error: No access token. Run setup first."
    exit 1
fi

API="https://graph.microsoft.com/v1.0/me"

# Folder-scoped base URLs
INBOX="$API/mailFolders/inbox/messages"
SENT="$API/mailFolders/sentItems/messages"
DRAFTS="$API/mailFolders/drafts/messages"
DELETED="$API/mailFolders/deleteditems/messages"
ARCHIVE="$API/mailFolders/archive/messages"
JUNK="$API/mailFolders/junkemail/messages"

case "$1" in
    unread)
        # List most recent inbox emails
        COUNT=${2:-10}
        curl -s "$INBOX?\$top=$COUNT&\$orderby=receivedDateTime%20desc&\$select=id,subject,from,receivedDateTime" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, from: .value.from.emailAddress.address, date: .value.receivedDateTime[0:16], id: .value.id[-20:]}'
        ;;

    read)
        # Read specific email by ID (searches across all folders for the ID)
        MSG_ID="$2"
        FULL_ID=$(curl -s "$API/messages?\$top=100&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.id | endswith(\"$MSG_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then
            echo "Message not found. Use the ID shown in inbox/sent/search results."
            exit 1
        fi

        curl -s "$API/messages/$FULL_ID?\$select=subject,from,receivedDateTime,body,toRecipients,ccRecipients,bccRecipients" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '{
                subject,
                from: .from.emailAddress,
                to: [.toRecipients[].emailAddress.address],
                cc: [.ccRecipients[].emailAddress.address],
                bcc: [.bccRecipients[].emailAddress.address],
                date: .receivedDateTime,
                body: (if .body.contentType == "html" then (.body.content | gsub("<[^>]*>"; "") | gsub("\\s+"; " ") | gsub("&nbsp;"; " ") | .[0:2000]) else .body.content[0:2000] end)
            }'
        ;;

    attachments)
        MSG_ID="$2"
        FULL_ID=$(curl -s "$API/messages?\$top=100&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.id | endswith(\"$MSG_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then echo "Message not found"; exit 1; fi

        curl -s "$API/messages/$FULL_ID/attachments" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.value[] | {name: .name, size: .size, contentType: .contentType, id: .id}'
        ;;

    download)
        MSG_ID="$2"; ATT_NAME="$3"; OUTPUT="${4:-.}"
        if [ -z "$ATT_NAME" ]; then
            echo "Usage: outlook-mail.sh download <msg-id> <attachment-name> [output-path]"; exit 1
        fi

        FULL_ID=$(curl -s "$API/messages?\$top=100&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.id | endswith(\"$MSG_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then echo "Message not found"; exit 1; fi

        ATT_DATA=$(curl -s "$API/messages/$FULL_ID/attachments" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.name == \"$ATT_NAME\")")

        if [ -z "$ATT_DATA" ]; then
            echo "Attachment not found: $ATT_NAME"
            curl -s "$API/messages/$FULL_ID/attachments" -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r '.value[].name'
            exit 1
        fi

        ATT_ID=$(echo "$ATT_DATA" | jq -r '.id')
        CONTENT=$(curl -s "$API/messages/$FULL_ID/attachments/$ATT_ID" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r '.contentBytes')

        OUTPUT_FILE="$OUTPUT/$ATT_NAME"
        echo "$CONTENT" | base64 -d > "$OUTPUT_FILE"

        if [ -f "$OUTPUT_FILE" ]; then
            SIZE=$(stat -c%s "$OUTPUT_FILE" 2>/dev/null || stat -f%z "$OUTPUT_FILE")
            echo "{\"status\": \"downloaded\", \"file\": \"$OUTPUT_FILE\", \"size\": $SIZE}"
        else
            echo "{\"error\": \"Failed to save file\"}"; exit 1
        fi
        ;;

    thread)
        MSG_ID="$2"
        FULL_ID=$(curl -s "$API/messages?\$top=100&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.id | endswith(\"$MSG_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then echo "Message not found"; exit 1; fi

        SUBJECT=$(curl -s "$API/messages/$FULL_ID?\$select=subject" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r '.subject' | sed 's/^RE: //i' | sed 's/^FW: //i' | sed 's/^Fwd: //i')

        KEYWORD=$(echo "$SUBJECT" | tr ' ' '\n' | awk '{print length, $0}' | sort -rn | head -1 | cut -d' ' -f2)
        if [ -z "$KEYWORD" ] || [ ${#KEYWORD} -lt 4 ]; then
            KEYWORD=$(echo "$SUBJECT" | cut -d' ' -f1)
        fi

        echo "Searching thread by keyword: $KEYWORD"
        # Search both inbox and sent for full thread picture
        echo "=== Inbox ==="
        curl -s "$INBOX?\$search=\"$KEYWORD\"&\$top=20&\$select=id,subject,from,receivedDateTime" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, from: .value.from.emailAddress.address, date: .value.receivedDateTime[0:16], id: .value.id[-20:]}'
        echo "=== Sent ==="
        curl -s "$SENT?\$search=\"$KEYWORD\"&\$top=20&\$select=id,subject,toRecipients,sentDateTime" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, to: .value.toRecipients[0].emailAddress.address, date: .value.sentDateTime[0:16], id: .value.id[-20:]}'
        ;;


    *)
        echo "Usage: outlook-mail.sh <command> [args]"
        echo ""
        echo "READING (inbox/received):"
        echo "  unread [count]                   - List unread emails (inbox only)"
        echo "  read <id>                        - Read email content"
        echo "  attachments <id>                 - List attachments"
        echo ""
        echo "THREAD:"
        echo "  thread <id>                      - View thread (shows inbox + sent)"
        echo ""
        echo "ATTACHMENTS:"
        echo "  attachments <id>                 - List attachments"
        echo "  download <id> <name> [path]      - Download attachment"
        ;;
esac