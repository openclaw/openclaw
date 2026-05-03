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
    inbox)
        # List inbox messages (received/got emails only)
        COUNT=${2:-10}
        curl -s "$INBOX?\$top=$COUNT&\$orderby=receivedDateTime%20desc&\$select=id,subject,from,receivedDateTime,isRead" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, from: .value.from.emailAddress.address, date: .value.receivedDateTime[0:16], read: .value.isRead, id: .value.id[-20:]}'
        ;;

    unread)
        # List unread messages in inbox only
        COUNT=${2:-20}
        curl -s "$INBOX?\$filter=isRead%20eq%20false&\$top=$COUNT&\$orderby=receivedDateTime%20desc&\$select=id,subject,from,receivedDateTime" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, from: .value.from.emailAddress.address, date: .value.receivedDateTime[0:16], id: .value.id[-20:]}'
        ;;

    sent)
        # List sent emails
        COUNT=${2:-10}
        curl -s "$SENT?\$top=$COUNT&\$orderby=sentDateTime%20desc&\$select=id,subject,toRecipients,sentDateTime" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, to: .value.toRecipients[0].emailAddress.address, date: .value.sentDateTime[0:16], id: .value.id[-20:]}'
        ;;

    search)
        # Search in inbox only (received emails)
        QUERY="$2"
        COUNT=${3:-20}
        curl -s "$INBOX?\$search=\"$QUERY\"&\$top=$COUNT&\$select=id,subject,from,receivedDateTime" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, from: .value.from.emailAddress.address, date: .value.receivedDateTime[0:16], id: .value.id[-20:]}'
        ;;

    search-sent)
        # Search in sent items only
        QUERY="$2"
        COUNT=${3:-20}
        curl -s "$SENT?\$search=\"$QUERY\"&\$top=$COUNT&\$select=id,subject,toRecipients,sentDateTime" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, to: .value.toRecipients[0].emailAddress.address, date: .value.sentDateTime[0:16], id: .value.id[-20:]}'
        ;;

    search-all)
        # Search across ALL folders (global) — use only when folder is unknown
        QUERY="$2"
        COUNT=${3:-20}
        curl -s "$API/messages?\$search=\"$QUERY\"&\$top=$COUNT&\$select=id,subject,from,toRecipients,receivedDateTime" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, from: .value.from.emailAddress.address, date: .value.receivedDateTime[0:16], id: .value.id[-20:]}'
        ;;

    search-drafts)
        # Search in drafts
        QUERY="$2"
        COUNT=${3:-20}
        curl -s "$DRAFTS?\$search=\"$QUERY\"&\$top=$COUNT&\$select=id,subject,toRecipients,createdDateTime" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, to: (.value.toRecipients[0].emailAddress.address // "no recipient"), date: .value.createdDateTime[0:16], id: .value.id[-20:]}'
        ;;

    search-deleted)
        # Search in deleted items
        QUERY="$2"
        COUNT=${3:-20}
        curl -s "$DELETED?\$search=\"$QUERY\"&\$top=$COUNT&\$select=id,subject,from,receivedDateTime" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, from: .value.from.emailAddress.address, date: .value.receivedDateTime[0:16], id: .value.id[-20:]}'
        ;;

    from)
        # List emails from specific sender — scoped to inbox
        SENDER="$2"
        COUNT=${3:-20}
        curl -s "$INBOX?\$search=\"from:$SENDER\"&\$top=$COUNT&\$select=id,subject,from,receivedDateTime,isRead" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq 'if .value then (.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, from: .value.from.emailAddress.address, date: .value.receivedDateTime[0:16], read: .value.isRead, id: .value.id[-20:]}) else {error: .error.message} end'
        ;;

    to)
        # List sent emails to a specific recipient
        RECIPIENT="$2"
        COUNT=${3:-20}
        curl -s "$SENT?\$search=\"to:$RECIPIENT\"&\$top=$COUNT&\$select=id,subject,toRecipients,sentDateTime" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq 'if .value then (.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, to: .value.toRecipients[0].emailAddress.address, date: .value.sentDateTime[0:16], id: .value.id[-20:]}) else {error: .error.message} end'
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

        curl -s "$API/messages/$FULL_ID?\$select=subject,from,receivedDateTime,body,toRecipients" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '{
                subject,
                from: .from.emailAddress,
                to: [.toRecipients[].emailAddress.address],
                date: .receivedDateTime,
                body: (if .body.contentType == "html" then (.body.content | gsub("<[^>]*>"; "") | gsub("\\s+"; " ") | gsub("&nbsp;"; " ") | .[0:2000]) else .body.content[0:2000] end)
            }'
        ;;

    mark-read)
        MSG_ID="$2"
        FULL_ID=$(curl -s "$API/messages?\$top=100&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.id | endswith(\"$MSG_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then echo "Message not found"; exit 1; fi

        curl -s -X PATCH "$API/messages/$FULL_ID" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{"isRead": true}' | jq '{status: "marked as read", subject: .subject, id: .id[-20:]}'
        ;;

    mark-unread)
        MSG_ID="$2"
        FULL_ID=$(curl -s "$API/messages?\$top=100&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.id | endswith(\"$MSG_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then echo "Message not found"; exit 1; fi

        curl -s -X PATCH "$API/messages/$FULL_ID" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{"isRead": false}' | jq '{status: "marked as unread", subject: .subject, id: .id[-20:]}'
        ;;

    folders)
        curl -s "$API/mailFolders" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.value[] | {name: .displayName, total: .totalItemCount, unread: .unreadItemCount}'
        ;;

    stats)
        curl -s "$API/mailFolders/inbox" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '{folder: .displayName, total: .totalItemCount, unread: .unreadItemCount}'
        ;;

    reply-draft)
        MSG_ID="$2"; BODY="$3"; CC="${4:-}"; BCC="${5:-}"
        FULL_ID=$(curl -s "$API/messages?\$top=100&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.id | endswith(\"$MSG_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then echo "Message not found"; exit 1; fi

        # Step 1: Create reply draft
        DRAFT=$(curl -s -X POST "$API/messages/$FULL_ID/createReply" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Length: 0")

        DRAFT_ID=$(echo "$DRAFT" | jq -r '.id')
        EXISTING_BODY=$(echo "$DRAFT" | jq -r '.body.content')

        # Step 2: Prepend reply body above existing quoted chain
        COMBINED_BODY="$BODY<br><br>$EXISTING_BODY"

        CC_JSON=$([ -n "$CC" ] && echo "$CC" | tr ',' '\n' | jq -R '{emailAddress: {address: .}}' | jq -s '.' || echo '[]')
        BCC_JSON=$([ -n "$BCC" ] && echo "$BCC" | tr ',' '\n' | jq -R '{emailAddress: {address: .}}' | jq -s '.' || echo '[]')

        PATCH_DATA=$(jq -n \
            --arg body "$COMBINED_BODY" \
            --argjson cc "$CC_JSON" \
            --argjson bcc "$BCC_JSON" \
            '{
                body: {contentType: "HTML", content: $body},
                ccRecipients: $cc,
                bccRecipients: $bcc
            }')

        curl -s -X PATCH "$API/messages/$DRAFT_ID" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$PATCH_DATA" > /dev/null

        echo "{\"status\": \"reply draft created\", \"original_id\": \"$MSG_ID\", \"draft_id\": \"${DRAFT_ID: -20}\"}"
        ;;

    delete)
        MSG_ID="$2"
        FULL_ID=$(curl -s "$API/messages?\$top=100&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.id | endswith(\"$MSG_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then echo "Message not found"; exit 1; fi

        curl -s -X POST "$API/messages/$FULL_ID/move" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{"destinationId": "deleteditems"}' | jq '{status: "moved to trash", subject: .subject, id: .id[-20:]}'
        ;;

    archive)
        MSG_ID="$2"
        FULL_ID=$(curl -s "$API/messages?\$top=100&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.id | endswith(\"$MSG_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then echo "Message not found"; exit 1; fi

        curl -s -X POST "$API/messages/$FULL_ID/move" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{"destinationId": "archive"}' | jq '{status: "archived", subject: .subject, id: .id[-20:]}'
        ;;

    flag)
        MSG_ID="$2"
        FULL_ID=$(curl -s "$API/messages?\$top=100&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.id | endswith(\"$MSG_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then echo "Message not found"; exit 1; fi

        curl -s -X PATCH "$API/messages/$FULL_ID" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{"flag": {"flagStatus": "flagged"}}' | jq '{status: "flagged", subject: .subject, id: .id[-20:]}'
        ;;

    unflag)
        MSG_ID="$2"
        FULL_ID=$(curl -s "$API/messages?\$top=100&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.id | endswith(\"$MSG_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then echo "Message not found"; exit 1; fi

        curl -s -X PATCH "$API/messages/$FULL_ID" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{"flag": {"flagStatus": "notFlagged"}}' | jq '{status: "unflagged", subject: .subject, id: .id[-20:]}'
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

    draft)
        TO="$2"; SUBJECT="$3"; BODY="$4"; CC="${5:-}"; BCC="${6:-}"
        if [ -z "$TO" ] || [ -z "$SUBJECT" ]; then
            echo "Usage: outlook-mail.sh draft <to> <subject> <body> [cc] [bcc]"; exit 1
        fi

        # Build recipient arrays from comma-separated values
        TO_JSON=$(echo "$TO" | tr ',' '\n' | jq -R '{emailAddress: {address: .}}' | jq -s '.')
        CC_JSON=$([ -n "$CC" ] && echo "$CC" | tr ',' '\n' | jq -R '{emailAddress: {address: .}}' | jq -s '.' || echo '[]')
        BCC_JSON=$([ -n "$BCC" ] && echo "$BCC" | tr ',' '\n' | jq -R '{emailAddress: {address: .}}' | jq -s '.' || echo '[]')

        DRAFT_DATA=$(jq -n \
            --arg subject "$SUBJECT" \
            --arg body "$BODY" \
            --argjson to "$TO_JSON" \
            --argjson cc "$CC_JSON" \
            --argjson bcc "$BCC_JSON" \
            '{
                subject: $subject,
                body: {contentType: "HTML", content: $body},
                toRecipients: $to,
                ccRecipients: $cc,
                bccRecipients: $bcc
            }')

        curl -s -X POST "$API/messages" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$DRAFT_DATA" \
            | jq '{status: "draft created", subject: .subject, to: [.toRecipients[].emailAddress.address], cc: [.ccRecipients[].emailAddress.address], id: .id[-20:]}'
        ;;

    drafts)
        COUNT=${2:-10}
        curl -s "$DRAFTS?\$top=$COUNT&\$select=id,subject,toRecipients,createdDateTime" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, to: (.value.toRecipients[0].emailAddress.address // "no recipient"), date: .value.createdDateTime[0:16], id: .value.id[-20:]}'
        ;;

    draft-attachment)
        TO="$2"; SUBJECT="$3"; BODY="$4"; FILE="$5"; CC="${6:-}"; BCC="${7:-}"
        if [ -z "$TO" ] || [ -z "$SUBJECT" ] || [ -z "$FILE" ]; then
            echo "Usage: outlook-mail.sh draft-attachment <to> <subject> <body> <file> [cc] [bcc]"; exit 1
        fi
        if [ ! -f "$FILE" ]; then
            echo "{\"error\": \"File not found: $FILE\"}"; exit 1
        fi

        FILENAME=$(basename "$FILE")
        MIME_TYPE=$(file -b --mime-type "$FILE" 2>/dev/null || echo "application/octet-stream")

        if [[ "$FILENAME" != *.* ]]; then
            case "$MIME_TYPE" in
                video/webm)      FILENAME="$FILENAME.webm" ;;
                video/mp4)       FILENAME="$FILENAME.mp4" ;;
                application/pdf) FILENAME="$FILENAME.pdf" ;;
            esac
        fi

        # Step 1: Create draft without attachment
        TO_JSON=$(echo "$TO" | tr ',' '\n' | jq -R '{emailAddress: {address: .}}' | jq -s '.')
        CC_JSON=$([ -n "$CC" ] && echo "$CC" | tr ',' '\n' | jq -R '{emailAddress: {address: .}}' | jq -s '.' || echo '[]')
        BCC_JSON=$([ -n "$BCC" ] && echo "$BCC" | tr ',' '\n' | jq -R '{emailAddress: {address: .}}' | jq -s '.' || echo '[]')

        DRAFT_DATA=$(jq -n \
            --arg subject "$SUBJECT" \
            --arg body "$BODY" \
            --argjson to "$TO_JSON" \
            --argjson cc "$CC_JSON" \
            --argjson bcc "$BCC_JSON" \
            '{
                subject: $subject,
                body: {contentType: "HTML", content: $body},
                toRecipients: $to,
                ccRecipients: $cc,
                bccRecipients: $bcc
            }')

        DRAFT=$(curl -s -X POST "$API/messages" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$DRAFT_DATA")

        DRAFT_ID=$(echo "$DRAFT" | jq -r '.id')

        if [ -z "$DRAFT_ID" ] || [ "$DRAFT_ID" = "null" ]; then
            echo "{\"error\": \"Failed to create draft\"}"
            exit 1
        fi

        # Step 2: Add attachment separately
        CONTENT_FILE=$(mktemp /tmp/outlook_content_XXXXXX.txt)
        base64 -w 0 "$FILE" > "$CONTENT_FILE"

        ATTACH_FILE=$(mktemp /tmp/outlook_attach_XXXXXX.json)
        jq -n \
            --arg filename "$FILENAME" \
            --arg mime "$MIME_TYPE" \
            --rawfile content "$CONTENT_FILE" \
            '{
                "@odata.type": "#microsoft.graph.fileAttachment",
                name: $filename,
                contentType: $mime,
                contentBytes: $content
            }' > "$ATTACH_FILE"
        rm -f "$CONTENT_FILE"

        curl -s -X POST "$API/messages/$DRAFT_ID/attachments" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            --data-binary "@$ATTACH_FILE" > /dev/null
        rm -f "$ATTACH_FILE"

        echo "{\"status\": \"draft created\", \"subject\": \"$SUBJECT\", \"to\": \"$TO\", \"cc\": \"$CC\", \"attachment\": \"$FILENAME\", \"id\": \"${DRAFT_ID: -20}\"}"
        ;;



    reply-draft-attachment)
        MSG_ID="$2"; BODY="$3"; FILE="$4"; CC="${5:-}"; BCC="${6:-}"
        if [ -z "$MSG_ID" ] || [ -z "$FILE" ]; then
            echo "Usage: outlook-mail.sh reply-draft-attachment <id> <body> <file> [cc] [bcc]"; exit 1
        fi
        if [ ! -f "$FILE" ]; then
            echo "{\"error\": \"File not found: $FILE\"}"; exit 1
        fi

        FULL_ID=$(curl -s "$API/messages?\$top=100&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.id | endswith(\"$MSG_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then echo "Message not found"; exit 1; fi

        FILENAME=$(basename "$FILE")
        MIME_TYPE=$(file -b --mime-type "$FILE" 2>/dev/null || echo "application/octet-stream")

        if [[ "$FILENAME" != *.* ]]; then
            case "$MIME_TYPE" in
                video/webm)      FILENAME="$FILENAME.webm" ;;
                video/mp4)       FILENAME="$FILENAME.mp4" ;;
                application/pdf) FILENAME="$FILENAME.pdf" ;;
            esac
        fi

        CONTENT_FILE=$(mktemp /tmp/outlook_content_XXXXXX.txt)
        base64 -w 0 "$FILE" > "$CONTENT_FILE"

        # Step 1: Create reply draft
        DRAFT=$(curl -s -X POST "$API/messages/$FULL_ID/createReply" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Length: 0")

        DRAFT_ID=$(echo "$DRAFT" | jq -r '.id')
        EXISTING_BODY=$(echo "$DRAFT" | jq -r '.body.content')

        # Step 2: Update body and add cc/bcc
        COMBINED_BODY="$BODY<br><br>$EXISTING_BODY"

        CC_JSON=$([ -n "$CC" ] && echo "$CC" | tr ',' '\n' | jq -R '{emailAddress: {address: .}}' | jq -s '.' || echo '[]')
        BCC_JSON=$([ -n "$BCC" ] && echo "$BCC" | tr ',' '\n' | jq -R '{emailAddress: {address: .}}' | jq -s '.' || echo '[]')

        PATCH_FILE=$(mktemp /tmp/outlook_patch_XXXXXX.json)
        jq -n \
            --arg body "$COMBINED_BODY" \
            --argjson cc "$CC_JSON" \
            --argjson bcc "$BCC_JSON" \
            '{
                body: {contentType: "HTML", content: $body},
                ccRecipients: $cc,
                bccRecipients: $bcc
            }' > "$PATCH_FILE"

        curl -s -X PATCH "$API/messages/$DRAFT_ID" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            --data-binary "@$PATCH_FILE" > /dev/null
        rm -f "$PATCH_FILE"

        # Step 3: Add attachment
        ATTACH_FILE=$(mktemp /tmp/outlook_attach_XXXXXX.json)
        jq -n \
            --arg filename "$FILENAME" \
            --arg mime "$MIME_TYPE" \
            --rawfile content "$CONTENT_FILE" \
            '{
                "@odata.type": "#microsoft.graph.fileAttachment",
                name: $filename,
                contentType: $mime,
                contentBytes: $content
            }' > "$ATTACH_FILE"
        rm -f "$CONTENT_FILE"

        curl -s -X POST "$API/messages/$DRAFT_ID/attachments" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            --data-binary "@$ATTACH_FILE" > /dev/null
        rm -f "$ATTACH_FILE"

        echo "{\"status\": \"reply draft created\", \"original_id\": \"$MSG_ID\", \"draft_id\": \"${DRAFT_ID: -20}\", \"attachment\": \"$FILENAME\", \"cc\": \"$CC\"}"
        ;;

    send-draft)
        MSG_ID="$2"
        FULL_ID=$(curl -s "$DRAFTS?\$top=50&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.id | endswith(\"$MSG_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then echo "Draft not found"; exit 1; fi

        RESULT=$(curl -s -w "\n%{http_code}" -X POST "$API/messages/$FULL_ID/send" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Length: 0")

        HTTP_CODE=$(echo "$RESULT" | tail -1)
        if [ "$HTTP_CODE" = "202" ]; then
            echo "{\"status\": \"draft sent\", \"id\": \"$MSG_ID\"}"
        else
            echo "$RESULT" | head -n -1 | jq '.error // .'
        fi
        ;;

    move)
        MSG_ID="$2"; FOLDER="$3"
        if [ -z "$FOLDER" ]; then
            echo "Usage: outlook-mail.sh move <id> <folder>"; exit 1
        fi

        FULL_ID=$(curl -s "$API/messages?\$top=100&\$select=id" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.id | endswith(\"$MSG_ID\")) | .id" | head -1)

        if [ -z "$FULL_ID" ]; then echo "Message not found"; exit 1; fi

        FOLDER_LOWER=$(echo "$FOLDER" | tr '[:upper:]' '[:lower:]')
        FOLDER_ID=$(curl -s "$API/mailFolders" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select((.displayName | ascii_downcase) == \"$FOLDER_LOWER\") | .id" | head -1)

        if [ -z "$FOLDER_ID" ]; then
            echo "Folder not found: $FOLDER"
            curl -s "$API/mailFolders" -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r '.value[].displayName'
            exit 1
        fi

        curl -s -X POST "$API/messages/$FULL_ID/move" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -d "{\"destinationId\": \"$FOLDER_ID\"}" | jq '{status: "moved", folder: "'"$FOLDER"'", subject: .subject, id: .id[-20:]}'
        ;;

    focused)
        COUNT=${2:-10}
        curl -s "$INBOX?\$filter=inferenceClassification%20eq%20'focused'&\$top=$COUNT&\$orderby=receivedDateTime%20desc&\$select=id,subject,from,receivedDateTime" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq 'if .value then (.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, from: .value.from.emailAddress.address, date: .value.receivedDateTime[0:16], id: .value.id[-20:]}) else {info: "Focused inbox not available or empty"} end'
        ;;

    other)
        COUNT=${2:-10}
        curl -s "$INBOX?\$filter=inferenceClassification%20eq%20'other'&\$top=$COUNT&\$orderby=receivedDateTime%20desc&\$select=id,subject,from,receivedDateTime" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq 'if .value then (.value | to_entries | .[] | {n: (.key + 1), subject: .value.subject, from: .value.from.emailAddress.address, date: .value.receivedDateTime[0:16], id: .value.id[-20:]}) else {info: "Other inbox not available or empty"} end'
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

    categories)
        curl -s "https://graph.microsoft.com/v1.0/me/outlook/masterCategories" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.value[] | {name: .displayName, color: .color, id: .id[0:8]}'
        ;;

    bulk-read)
        shift
        if [ $# -eq 0 ]; then echo "Usage: outlook-mail.sh bulk-read <id1> <id2> ..."; exit 1; fi
        SUCCESS=0; FAILED=0
        for MSG_ID in "$@"; do
            FULL_ID=$(curl -s "$API/messages?\$top=100&\$select=id" \
                -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.id | endswith(\"$MSG_ID\")) | .id" | head -1)
            if [ -n "$FULL_ID" ]; then
                curl -s -X PATCH "$API/messages/$FULL_ID" \
                    -H "Authorization: Bearer $ACCESS_TOKEN" \
                    -H "Content-Type: application/json" \
                    -d '{"isRead": true}' > /dev/null
                SUCCESS=$((SUCCESS + 1))
            else
                FAILED=$((FAILED + 1))
            fi
        done
        echo "{\"status\": \"bulk operation complete\", \"marked_read\": $SUCCESS, \"not_found\": $FAILED}"
        ;;

    bulk-delete)
        shift
        if [ $# -eq 0 ]; then echo "Usage: outlook-mail.sh bulk-delete <id1> <id2> ..."; exit 1; fi
        SUCCESS=0; FAILED=0
        for MSG_ID in "$@"; do
            FULL_ID=$(curl -s "$API/messages?\$top=100&\$select=id" \
                -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select(.id | endswith(\"$MSG_ID\")) | .id" | head -1)
            if [ -n "$FULL_ID" ]; then
                curl -s -X POST "$API/messages/$FULL_ID/move" \
                    -H "Authorization: Bearer $ACCESS_TOKEN" \
                    -H "Content-Type: application/json" \
                    -d '{"destinationId": "deleteditems"}' > /dev/null
                SUCCESS=$((SUCCESS + 1))
            else
                FAILED=$((FAILED + 1))
            fi
        done
        echo "{\"status\": \"bulk delete complete\", \"deleted\": $SUCCESS, \"not_found\": $FAILED}"
        ;;

    create-folder)
        FOLDER_NAME="$2"; PARENT="${3:-}"
        if [ -z "$FOLDER_NAME" ]; then echo "Usage: outlook-mail.sh create-folder <name> [parent]"; exit 1; fi

        if [ -n "$PARENT" ]; then
            PARENT_LOWER=$(echo "$PARENT" | tr '[:upper:]' '[:lower:]')
            PARENT_ID=$(curl -s "$API/mailFolders" \
                -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select((.displayName | ascii_downcase) == \"$PARENT_LOWER\") | .id" | head -1)
            if [ -z "$PARENT_ID" ]; then echo "Parent folder not found: $PARENT"; exit 1; fi
            curl -s -X POST "$API/mailFolders/$PARENT_ID/childFolders" \
                -H "Authorization: Bearer $ACCESS_TOKEN" \
                -H "Content-Type: application/json" \
                -d "{\"displayName\": \"$FOLDER_NAME\"}" | jq '{status: "folder created", name: .displayName, parent: "'"$PARENT"'", id: .id[-20:]}'
        else
            curl -s -X POST "$API/mailFolders" \
                -H "Authorization: Bearer $ACCESS_TOKEN" \
                -H "Content-Type: application/json" \
                -d "{\"displayName\": \"$FOLDER_NAME\"}" | jq '{status: "folder created", name: .displayName, id: .id[-20:]}'
        fi
        ;;

    delete-folder)
        FOLDER_NAME="$2"
        if [ -z "$FOLDER_NAME" ]; then echo "Usage: outlook-mail.sh delete-folder <name>"; exit 1; fi

        FOLDER_LOWER=$(echo "$FOLDER_NAME" | tr '[:upper:]' '[:lower:]')
        FOLDER_ID=$(curl -s "$API/mailFolders" \
            -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".value[] | select((.displayName | ascii_downcase) == \"$FOLDER_LOWER\") | .id" | head -1)

        if [ -z "$FOLDER_ID" ]; then echo "Folder not found: $FOLDER_NAME"; exit 1; fi

        RESULT=$(curl -s -w "\n%{http_code}" -X DELETE "$API/mailFolders/$FOLDER_ID" \
            -H "Authorization: Bearer $ACCESS_TOKEN")

        HTTP_CODE=$(echo "$RESULT" | tail -1)
        if [ "$HTTP_CODE" = "204" ]; then
            echo "{\"status\": \"folder deleted\", \"name\": \"$FOLDER_NAME\"}"
        else
            echo "$RESULT" | head -n -1 | jq '.error // .'
        fi
        ;;

    *)
        echo "Usage: outlook-mail.sh <command> [args]"
        echo ""
        echo "READING (inbox/received):"
        echo "  inbox [count]                    - List received emails (inbox only)"
        echo "  unread [count]                   - List unread emails (inbox only)"
        echo "  focused [count]                  - Focused inbox"
        echo "  other [count]                    - Other/low-priority inbox"
        echo "  from <email> [count]             - Emails from sender (inbox only)"
        echo "  read <id>                        - Read email content"
        echo "  attachments <id>                 - List attachments"
        echo ""
        echo "SENT:"
        echo "  sent [count]                     - List sent emails"
        echo "  to <email> [count]               - Sent emails to recipient"
        echo ""
        echo "SEARCH (folder-scoped):"
        echo "  search \"query\" [count]           - Search inbox (received only)"
        echo "  search-sent \"query\" [count]      - Search sent items"
        echo "  search-drafts \"query\" [count]    - Search drafts"
        echo "  search-deleted \"query\" [count]   - Search deleted items"
        echo "  search-all \"query\" [count]       - Search ALL folders (use sparingly)"
        echo ""
        echo "THREAD:"
        echo "  thread <id>                      - View thread (shows inbox + sent)"
        echo ""
        echo "MANAGING:"
        echo "  mark-read <id>                   - Mark as read"
        echo "  mark-unread <id>                 - Mark as unread"
        echo "  flag <id>                        - Flag as important"
        echo "  unflag <id>                      - Remove flag"
        echo "  delete <id>                      - Move to trash"
        echo "  archive <id>                     - Move to archive"
        echo "  move <id> <folder>               - Move to folder"
        echo ""
        echo "DRAFTS AND SENDING THEM:"
        echo "  draft <to> <subj> <body> [cc] [bcc]                        - Create draft for review (does not send)"
        echo "  reply-draft <id> <body> [cc] [bcc]                         - Create reply draft for review (does not send)"
        echo "  draft-attachment <to> <subj> \"body\" <file> [cc] [bcc]    - Create draft with attachment (does not send)"
        echo "  reply-draft-attachment <id> \"body\" <file> [cc] [bcc]     - Create reply draft with attachment (does not send)"
        echo "  drafts [count]                                             - List drafts"
        echo "  send-draft <id>                                            - Send a draft"
        echo ""
        echo "ATTACHMENTS:"
        echo "  attachments <id>                 - List attachments"
        echo "  download <id> <name> [path]      - Download attachment"
        echo ""
        echo "FOLDERS:"
        echo "  folders                          - List mail folders"
        echo "  create-folder <name> [parent]    - Create folder"
        echo "  delete-folder <name>             - Delete folder"
        echo "  categories                       - List categories"
        echo ""
        echo "BULK:"
        echo "  bulk-read <id1> <id2>...         - Mark multiple as read"
        echo "  bulk-delete <id1> <id2>...       - Delete multiple"
        echo ""
        echo "INFO:"
        echo "  stats                            - Inbox statistics"
        ;;
esac