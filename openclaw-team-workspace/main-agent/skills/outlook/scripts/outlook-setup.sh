#!/bin/bash
# Outlook OAuth Setup
# Creates/reuses App Registration and configures OAuth tokens.
#
# Usage:
#   ./scripts/outlook-setup.sh
#   ./scripts/outlook-setup.sh 'http://localhost/?code=...&session_state=...'

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.outlook-mcp"
CONFIG_FILE="$CONFIG_DIR/config.json"
CREDS_FILE="$CONFIG_DIR/credentials.json"

# Try to find the triage Outlook skill in common workspace locations.
if [ -d "$HOME/workspace/outlook-traige-agent/skills/outlook" ]; then
    TRIAGE_DIR="$HOME/workspace/outlook-traige-agent/skills/outlook"
elif [ -d "$HOME/workspace/outlook-triage-agent/skills/outlook" ]; then
    TRIAGE_DIR="$HOME/workspace/outlook-triage-agent/skills/outlook"
elif [ -d "$HOME/openclaw-team-workspace/outlook-triage-agent/skills/outlook" ]; then
    TRIAGE_DIR="$HOME/openclaw-team-workspace/outlook-triage-agent/skills/outlook"
elif [ -d "$HOME/openclaw-team-workspace/outlook-traige-agent/skills/outlook" ]; then
    TRIAGE_DIR="$HOME/openclaw-team-workspace/outlook-traige-agent/skills/outlook"
else
    TRIAGE_DIR=""
fi

APP_NAME="Clawdbot-Outlook"
REDIRECT_URI="http://localhost"
SCOPES="https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/MailboxSettings.Read https://graph.microsoft.com/User.ReadBasic.All offline_access"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== Outlook OAuth Setup ===${NC}"
echo ""

check_prereqs() {
    for cmd in jq curl; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            echo -e "${RED}Error: $cmd not installed${NC}"
            exit 1
        fi
    done
}

check_existing_creds() {
    if [ -f "$CONFIG_FILE" ]; then
        local existing_id existing_secret
        existing_id="$(jq -r '.client_id // empty' "$CONFIG_FILE" 2>/dev/null || true)"
        existing_secret="$(jq -r '.client_secret // empty' "$CONFIG_FILE" 2>/dev/null || true)"

        if [ -n "$existing_id" ] && [ -n "$existing_secret" ]; then
            echo -e "${YELLOW}Found existing credentials in ${CONFIG_FILE}${NC}"
            echo "  client_id: $existing_id"
            read -p "Use them? [Y/n] " -n 1 -r
            echo
            if [[ ! "${REPLY:-}" =~ ^[Nn]$ ]]; then
                CLIENT_ID="$existing_id"
                CLIENT_SECRET="$existing_secret"
                APP_ID="$CLIENT_ID"
                echo -e "${GREEN}✓ Using existing credentials from config${NC}"
                return 0
            fi
        fi
    fi

    echo -e "${YELLOW}Do you have an existing App Registration/client credentials?${NC}"
    read -p "Paste client ID/secret manually? [y/N] " -n 1 -r
    echo
    if [[ "${REPLY:-}" =~ ^[Yy]$ ]]; then
        read -r -p "Client ID: " CLIENT_ID
        read -r -s -p "Client Secret: " CLIENT_SECRET
        echo
        APP_ID="$CLIENT_ID"
        echo -e "${GREEN}✓ Using provided credentials${NC}"
        return 0
    fi

    return 1
}

azure_login() {
    if ! command -v az >/dev/null 2>&1; then
        echo -e "${RED}Error: Azure CLI not installed${NC}"
        echo "Install Azure CLI or provide existing client ID/secret."
        exit 1
    fi

    echo -e "${YELLOW}Step 1: Azure Login${NC}"

    if az account show >/dev/null 2>&1; then
        CURRENT_USER="$(az account show --query user.name -o tsv)"
        echo -e "Currently logged in as: ${GREEN}$CURRENT_USER${NC}"
        read -p "Continue with this account? [Y/n] " -n 1 -r
        echo
        if [[ "${REPLY:-}" =~ ^[Nn]$ ]]; then
            az logout 2>/dev/null || true
        else
            return 0
        fi
    fi

    echo "Opening browser for Azure login..."
    echo "(If no browser available, use device code flow.)"

    if ! az login --use-device-code; then
        echo -e "${RED}Login failed${NC}"
        exit 1
    fi

    echo -e "${GREEN}✓ Logged in successfully${NC}"
}

create_app() {
    echo ""
    echo -e "${YELLOW}Step 2: Creating App Registration${NC}"

    EXISTING_APP="$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv 2>/dev/null || true)"

    if [ -n "$EXISTING_APP" ] && [ "$EXISTING_APP" != "null" ]; then
        echo -e "App '$APP_NAME' already exists: ${BLUE}$EXISTING_APP${NC}"
        read -p "Use existing app? [Y/n] " -n 1 -r
        echo
        if [[ ! "${REPLY:-}" =~ ^[Nn]$ ]]; then
            APP_ID="$EXISTING_APP"
            echo -e "${GREEN}✓ Using existing app${NC}"
            return 0
        fi

        APP_NAME="$APP_NAME-$(date +%s)"
        echo "Creating new app: $APP_NAME"
    fi

    APP_RESULT="$(az ad app create \
        --display-name "$APP_NAME" \
        --sign-in-audience "AzureADandPersonalMicrosoftAccount" \
        --web-redirect-uris "$REDIRECT_URI" \
        --query "{appId: appId, objectId: id}" -o json)"

    APP_ID="$(echo "$APP_RESULT" | jq -r '.appId')"
    echo -e "${GREEN}✓ App created: $APP_ID${NC}"
}

create_secret() {
    echo -e "${RED}WARNING: This will reset/create a client secret and may invalidate existing tokens.${NC}"
    read -p "Are you sure? [y/N] " -n 1 -r CONFIRM
    echo

    if [[ ! "${CONFIRM:-}" =~ ^[Yy]$ ]]; then
        echo "Skipping secret reset."

        if [ ! -f "$CONFIG_FILE" ]; then
            echo -e "${RED}No existing config to load from.${NC}"
            echo "Re-run and choose to reset/create a secret, or paste credentials manually."
            exit 1
        fi

        echo -e "${YELLOW}Loading existing credentials from config...${NC}"
        CLIENT_ID="$(jq -r '.client_id // empty' "$CONFIG_FILE")"
        CLIENT_SECRET="$(jq -r '.client_secret // empty' "$CONFIG_FILE")"

        if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
            echo -e "${RED}Existing config is missing client_id or client_secret.${NC}"
            exit 1
        fi

        return
    fi

    echo ""
    echo -e "${YELLOW}Step 3: Creating Client Secret${NC}"

    SECRET_RESULT="$(az ad app credential reset \
        --id "$APP_ID" \
        --display-name "clawdbot-secret" \
        --years 2 \
        --query "{clientId: appId, clientSecret: password}" -o json 2>/dev/null)"

    CLIENT_ID="$(echo "$SECRET_RESULT" | jq -r '.clientId')"
    CLIENT_SECRET="$(echo "$SECRET_RESULT" | jq -r '.clientSecret')"

    if [ -z "$CLIENT_SECRET" ] || [ "$CLIENT_SECRET" = "null" ]; then
        echo -e "${RED}Failed to create secret${NC}"
        exit 1
    fi

    echo -e "${GREEN}✓ Secret created${NC}"
}

add_permissions() {
    echo ""
    echo -e "${YELLOW}Step 4: Adding API Permissions${NC}"

    GRAPH_API="00000003-0000-0000-c000-000000000000"

    MAIL_RW_ID="$(az ad sp show --id "$GRAPH_API" --query "oauth2PermissionScopes[?value=='Mail.ReadWrite'].id" -o tsv 2>/dev/null || true)"
    MAIL_SEND_ID="$(az ad sp show --id "$GRAPH_API" --query "oauth2PermissionScopes[?value=='Mail.Send'].id" -o tsv 2>/dev/null || true)"
    CAL_RW_ID="$(az ad sp show --id "$GRAPH_API" --query "oauth2PermissionScopes[?value=='Calendars.ReadWrite'].id" -o tsv 2>/dev/null || true)"
    USER_READ_ID="$(az ad sp show --id "$GRAPH_API" --query "oauth2PermissionScopes[?value=='User.Read'].id" -o tsv 2>/dev/null || true)"
    MBOX_SETTINGS_ID="$(az ad sp show --id "$GRAPH_API" --query "oauth2PermissionScopes[?value=='MailboxSettings.Read'].id" -o tsv 2>/dev/null || true)"
    USER_BASIC_ALL_ID="$(az ad sp show --id "$GRAPH_API" --query "oauth2PermissionScopes[?value=='User.ReadBasic.All'].id" -o tsv 2>/dev/null || true)"

    az ad app permission add --id "$APP_ID" \
        --api "$GRAPH_API" \
        --api-permissions \
            "$MAIL_RW_ID=Scope" \
            "$MAIL_SEND_ID=Scope" \
            "$CAL_RW_ID=Scope" \
            "$USER_READ_ID=Scope" \
            "$MBOX_SETTINGS_ID=Scope" \
            "$USER_BASIC_ALL_ID=Scope" 2>/dev/null || true

    echo -e "${GREEN}✓ Permissions added/requested:${NC}"
    echo "    Mail.ReadWrite, Mail.Send, Calendars.ReadWrite,"
    echo "    User.Read, MailboxSettings.Read, User.ReadBasic.All"
}

save_config() {
    if [ -z "${CLIENT_ID:-}" ] || [ -z "${CLIENT_SECRET:-}" ]; then
        echo -e "${RED}Refusing to write config: CLIENT_ID or CLIENT_SECRET is empty${NC}"
        exit 1
    fi

    mkdir -p "$CONFIG_DIR"

    if [ -f "$CONFIG_FILE" ]; then
        cp "$CONFIG_FILE" "$CONFIG_FILE.bak.$(date +%Y%m%d-%H%M%S)"
    fi

    echo ""
    echo -e "${YELLOW}Saving Configuration${NC}"

    jq -n \
        --arg client_id "$CLIENT_ID" \
        --arg client_secret "$CLIENT_SECRET" \
        --arg timezone "" \
        '{
            "client_id": $client_id,
            "client_secret": $client_secret,
            "timezone": $timezone
        }' > "$CONFIG_FILE"

    chmod 600 "$CONFIG_FILE"
    echo -e "${GREEN}✓ Config saved to $CONFIG_FILE${NC}"
}

authorize() {
    echo ""
    echo -e "${YELLOW}User Authorization${NC}"
    echo ""

    AUTH_URL="https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=$CLIENT_ID&response_type=code&redirect_uri=$REDIRECT_URI&scope=$(printf '%s' "$SCOPES" | sed 's/ /%20/g')&response_mode=query"

    REDIRECT_URL="${1:-}"

    if [ -z "$REDIRECT_URL" ]; then
        echo "Open this URL in your browser:"
        echo ""
        echo -e "${BLUE}$AUTH_URL${NC}"
        echo ""
        echo "After authorizing, you will be redirected to a page that may not load."
        echo "Copy the FULL URL from the address bar and paste it here:"
        echo ""
        read -r -p "URL: " REDIRECT_URL
    else
        echo "Using redirect URL passed as argument."
    fi

    AUTH_CODE="$(printf '%s' "$REDIRECT_URL" | grep -oP 'code=\K[^&]+' || true)"

    if [ -z "$AUTH_CODE" ]; then
        echo -e "${RED}Could not extract authorization code from URL${NC}"
        echo "Received URL was:"
        printf '%s\n' "$REDIRECT_URL"
        exit 1
    fi

    echo ""
    echo "Exchanging code for tokens..."

    TOKEN_RESPONSE="$(curl -s -X POST "https://login.microsoftonline.com/common/oauth2/v2.0/token" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        --data-urlencode "client_id=$CLIENT_ID" \
        --data-urlencode "client_secret=$CLIENT_SECRET" \
        --data-urlencode "code=$AUTH_CODE" \
        --data-urlencode "redirect_uri=$REDIRECT_URI" \
        --data-urlencode "grant_type=authorization_code" \
        --data-urlencode "scope=$SCOPES")"

    if echo "$TOKEN_RESPONSE" | jq -e '.access_token' >/dev/null 2>&1; then
        mkdir -p "$CONFIG_DIR"

        if [ -f "$CREDS_FILE" ]; then
            cp "$CREDS_FILE" "$CREDS_FILE.bak.$(date +%Y%m%d-%H%M%S)"
        fi

        NOW="$(date +%s)"
        EXPIRES_IN="$(echo "$TOKEN_RESPONSE" | jq -r '.expires_in // 3600')"
        EXPIRES_AT="$((NOW + EXPIRES_IN))"

        echo "$TOKEN_RESPONSE" | jq --argjson exp "$EXPIRES_AT" '. + {"expires_at": $exp}' > "$CREDS_FILE"

        chmod 600 "$CREDS_FILE"
        echo -e "${GREEN}✓ Tokens saved to $CREDS_FILE${NC}"
    else
        echo -e "${RED}Failed to get tokens:${NC}"
        echo "$TOKEN_RESPONSE" | jq '.'
        exit 1
    fi
}

test_connection() {
    echo ""
    echo -e "${YELLOW}Testing Connection${NC}"

    ACCESS_TOKEN="$(jq -r '.access_token' "$CREDS_FILE")"

    INBOX="$(curl -s "https://graph.microsoft.com/v1.0/me/mailFolders/inbox" \
        -H "Authorization: Bearer $ACCESS_TOKEN")"

    if echo "$INBOX" | jq -e '.totalItemCount' >/dev/null 2>&1; then
        TOTAL="$(echo "$INBOX" | jq '.totalItemCount')"
        UNREAD="$(echo "$INBOX" | jq '.unreadItemCount')"
        echo -e "${GREEN}✓ Inbox access (Mail.ReadWrite)${NC}"
        echo -e "    ${BLUE}$TOTAL${NC} emails (${YELLOW}$UNREAD${NC} unread)"
    else
        echo -e "${RED}✗ Inbox access failed (Mail.ReadWrite)${NC}"
        echo "$INBOX" | jq '.error.message // .'
        exit 1
    fi

    MBOX_RESPONSE="$(curl -s "https://graph.microsoft.com/v1.0/me/mailboxSettings/timeZone" \
        -H "Authorization: Bearer $ACCESS_TOKEN")"

    if echo "$MBOX_RESPONSE" | jq -e '.value' >/dev/null 2>&1; then
        TIMEZONE="$(echo "$MBOX_RESPONSE" | jq -r '.value')"
        jq --arg tz "$TIMEZONE" '.timezone = $tz' "$CONFIG_FILE" > /tmp/outlook-config.json \
            && mv /tmp/outlook-config.json "$CONFIG_FILE"
        chmod 600 "$CONFIG_FILE"
        echo -e "${GREEN}✓ Mailbox settings (MailboxSettings.Read)${NC}"
        echo -e "    Timezone cached: ${BLUE}$TIMEZONE${NC}"
    else
        echo -e "${YELLOW}⚠ Mailbox settings access failed (MailboxSettings.Read)${NC}"
        echo "$MBOX_RESPONSE" | jq '.error.message // .'
        echo "    Timezone will not be cached automatically."
    fi

    PEOPLE_RESPONSE="$(curl -s "https://graph.microsoft.com/v1.0/users?\$top=1&\$select=displayName" \
        -H "Authorization: Bearer $ACCESS_TOKEN")"

    if echo "$PEOPLE_RESPONSE" | jq -e '.value' >/dev/null 2>&1; then
        echo -e "${GREEN}✓ People lookup (User.ReadBasic.All)${NC}"
    else
        echo -e "${YELLOW}⚠ People lookup failed (User.ReadBasic.All)${NC}"
        echo "$PEOPLE_RESPONSE" | jq '.error.message // .'
        echo "    Person-by-name lookups may not work until admin consent is granted."
    fi
}

setup_cron() {
    echo ""
    echo -e "${YELLOW}Setting up scheduled jobs${NC}"

    if [ -z "${TRIAGE_DIR:-}" ] || [ ! -d "$TRIAGE_DIR" ]; then
        echo -e "${YELLOW}⚠ Skipping scheduler setup — triage Outlook skill directory not found.${NC}"
        echo "    TRIAGE_DIR=${TRIAGE_DIR:-<empty>}"
        return
    fi

    local missing=()
    for script in check-and-trigger.sh outlook-seen.sh; do
        if [ ! -f "$TRIAGE_DIR/$script" ]; then
            missing+=("$script (missing)")
        elif [ ! -x "$TRIAGE_DIR/$script" ]; then
            missing+=("$script (not executable)")
        fi
    done

    if [ "${#missing[@]}" -gt 0 ]; then
        echo -e "${YELLOW}⚠ Skipping scheduler setup — required scripts unavailable in $TRIAGE_DIR:${NC}"
        for s in "${missing[@]}"; do
            echo "    $s"
        done
        echo "    Fix with:"
        echo "    chmod +x \"$TRIAGE_DIR/check-and-trigger.sh\" \"$TRIAGE_DIR/outlook-seen.sh\""
        return
    fi

    local config_dir="${OPENCLAW_HOME:-$HOME/.openclaw}"
    local crontab_file="$config_dir/crontab"

    mkdir -p "$config_dir"

    echo -e "${YELLOW}Seeding seen email store${NC}"
    "$TRIAGE_DIR/outlook-seen.sh" seed || {
        echo -e "${YELLOW}⚠ Seen-store seed failed; continuing, but first triage run may process existing unread emails.${NC}"
    }

    local existing_cron=""
    if [ -f "$crontab_file" ]; then
        existing_cron="$(cat "$crontab_file" || true)"
    fi

    {
        if [ -n "$existing_cron" ]; then
            printf '%s\n' "$existing_cron" | grep -v -E 'outlook-hook\.sh|check-and-trigger|outlook-seen.*prune' || true
        fi

        echo "* * * * * $TRIAGE_DIR/check-and-trigger.sh"
        echo "0 3 * * * $TRIAGE_DIR/outlook-seen.sh prune"
    } > "$crontab_file"

    chmod 600 "$crontab_file"

    echo -e "${GREEN}✓ Supercronic jobs registered${NC}"
    echo "  - Email triage: every minute ($TRIAGE_DIR/check-and-trigger.sh)"
    echo "  - Seen store prune: daily at 3am ($TRIAGE_DIR/outlook-seen.sh prune)"
    echo "  - Crontab file: $crontab_file"

    echo ""
    echo "Current Supercronic crontab:"
    cat "$crontab_file"

        echo -e "${YELLOW}Restarting Supercronic scheduler${NC}"

    if command -v supercronic >/dev/null 2>&1; then
        pkill -x supercronic 2>/dev/null || true

        nohup supercronic "$crontab_file" \
            >> "$config_dir/logs/supercronic.log" \
            2>&1 &

        echo -e "${GREEN}✓ Supercronic restarted${NC}"
    else
        echo -e "${YELLOW}⚠ supercronic not installed; jobs will start on next container restart.${NC}"
    fi
    }

main() {
    check_prereqs

    if ! check_existing_creds; then
        azure_login
        create_app
        create_secret
        add_permissions
    fi

    save_config
    authorize "${1:-}"
    test_connection
    setup_cron

    echo ""
    echo -e "${GREEN}=== Setup Complete! ===${NC}"
    echo ""
    echo "You can now use:"
    echo "  outlook-mail.sh inbox"
    echo "  outlook-mail.sh unread"
    echo "  outlook-mail.sh search X"
    echo "  outlook-calendar.sh today"
    echo "  outlook-calendar.sh week"
    echo "  outlook-token.sh refresh"
}

main "$@"