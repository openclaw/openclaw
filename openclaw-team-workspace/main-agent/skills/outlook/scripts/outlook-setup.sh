#!/bin/bash
# Outlook OAuth Setup
# Automatically creates App Registration and configures OAuth
#
# NOTE: This script lives in the main agent's workspace but sets up cron
# jobs that run scripts from the triage agent's workspace. See TRIAGE_DIR.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRIAGE_DIR="$HOME/Projects/openclaw-team-workspace/outlook-traige-agent/skills/outlook"
CONFIG_DIR="$HOME/.outlook-mcp"
CONFIG_FILE="$CONFIG_DIR/config.json"
CREDS_FILE="$CONFIG_DIR/credentials.json"

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
        if ! command -v "$cmd" &> /dev/null; then
            echo -e "${RED}Error: $cmd not installed${NC}"
            echo "Install with: sudo apt install $cmd"
            exit 1
        fi
    done
}

# Fast path: if config.json on disk already has valid client_id + client_secret,
# offer to reuse. This skips azure_login/create_app/create_secret/add_permissions.
# Fast path assumes permissions on the app registration are already correct —
# if you added a new scope to $SCOPES, decline here and take the slow path so
# add_permissions runs.
check_existing_creds() {
    if [ -f "$CONFIG_FILE" ]; then
        local existing_id existing_secret
        existing_id=$(jq -r '.client_id // empty' "$CONFIG_FILE" 2>/dev/null)
        existing_secret=$(jq -r '.client_secret // empty' "$CONFIG_FILE" 2>/dev/null)
        if [ -n "$existing_id" ] && [ -n "$existing_secret" ]; then
            echo -e "${YELLOW}Found existing credentials in ${CONFIG_FILE}${NC}"
            echo "  client_id: $existing_id"
            read -p "Use them? [Y/n] " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Nn]$ ]]; then
                CLIENT_ID="$existing_id"
                CLIENT_SECRET="$existing_secret"
                APP_ID="$CLIENT_ID"
                echo -e "${GREEN}✓ Using existing credentials from config${NC}"
                return 0
            fi
        fi
    fi

    # No usable config on disk — offer paste-from-elsewhere path
    echo -e "${YELLOW}Do you have an existing App Registration (e.g. shared company credentials)?${NC}"
    read -p "Paste client ID/secret manually? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        read -p "Client ID: " CLIENT_ID
        read -s -p "Client Secret: " CLIENT_SECRET
        echo
        APP_ID="$CLIENT_ID"
        echo -e "${GREEN}✓ Using provided credentials${NC}"
        return 0
    fi
    return 1
}

azure_login() {
    if ! command -v az &> /dev/null; then
        echo -e "${RED}Error: Azure CLI not installed${NC}"
        echo "Install with: curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash"
        exit 1
    fi

    echo -e "${YELLOW}Step 1: Azure Login${NC}"

    if az account show &> /dev/null; then
        CURRENT_USER=$(az account show --query user.name -o tsv)
        echo -e "Currently logged in as: ${GREEN}$CURRENT_USER${NC}"
        read -p "Continue with this account? [Y/n] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Nn]$ ]]; then
            az logout 2>/dev/null || true
        else
            return 0
        fi
    fi

    echo "Opening browser for Azure login..."
    echo "(If no browser available, use: az login --use-device-code)"

    if ! az login --use-device-code; then
        echo -e "${RED}Login failed${NC}"
        exit 1
    fi

    echo -e "${GREEN}✓ Logged in successfully${NC}"
}

create_app() {
    echo ""
    echo -e "${YELLOW}Step 2: Creating App Registration${NC}"

    EXISTING_APP=$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv 2>/dev/null)

    if [ -n "$EXISTING_APP" ] && [ "$EXISTING_APP" != "null" ]; then
        echo -e "App '$APP_NAME' already exists: ${BLUE}$EXISTING_APP${NC}"
        read -p "Use existing app? [Y/n] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Nn]$ ]]; then
            APP_ID="$EXISTING_APP"
            echo -e "${GREEN}✓ Using existing app${NC}"
            return 0
        fi
        APP_NAME="$APP_NAME-$(date +%s)"
        echo "Creating new app: $APP_NAME"
    fi

    APP_RESULT=$(az ad app create \
        --display-name "$APP_NAME" \
        --sign-in-audience "AzureADandPersonalMicrosoftAccount" \
        --web-redirect-uris "$REDIRECT_URI" \
        --query "{appId: appId, objectId: id}" -o json)

    APP_ID=$(echo "$APP_RESULT" | jq -r '.appId')
    echo -e "${GREEN}✓ App created: $APP_ID${NC}"
}

create_secret() {
    echo -e "${RED}WARNING: This will reset the client secret and invalidate all existing tokens!${NC}"
    read -p "Are you sure? [y/N] " -n 1 -r CONFIRM
    echo
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        echo "Skipping secret reset."
        if [ ! -f "$CONFIG_FILE" ]; then
            echo -e "${RED}No existing config to load from. Re-run and choose to reset the secret, or paste credentials when prompted.${NC}"
            exit 1
        fi
        echo -e "${YELLOW}Loading existing credentials from config...${NC}"
        CLIENT_ID=$(jq -r '.client_id // empty' "$CONFIG_FILE")
        CLIENT_SECRET=$(jq -r '.client_secret // empty' "$CONFIG_FILE")
        if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
            echo -e "${RED}Existing config is missing client_id or client_secret.${NC}"
            exit 1
        fi
        return
    fi
    echo ""
    echo -e "${YELLOW}Step 3: Creating Client Secret${NC}"

    SECRET_RESULT=$(az ad app credential reset \
        --id "$APP_ID" \
        --display-name "clawdbot-secret" \
        --years 2 \
        --query "{clientId: appId, clientSecret: password}" -o json 2>/dev/null)

    CLIENT_ID=$(echo "$SECRET_RESULT" | jq -r '.clientId')
    CLIENT_SECRET=$(echo "$SECRET_RESULT" | jq -r '.clientSecret')

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

    MAIL_RW_ID=$(az ad sp show --id "$GRAPH_API" --query "oauth2PermissionScopes[?value=='Mail.ReadWrite'].id" -o tsv 2>/dev/null)
    MAIL_SEND_ID=$(az ad sp show --id "$GRAPH_API" --query "oauth2PermissionScopes[?value=='Mail.Send'].id" -o tsv 2>/dev/null)
    CAL_RW_ID=$(az ad sp show --id "$GRAPH_API" --query "oauth2PermissionScopes[?value=='Calendars.ReadWrite'].id" -o tsv 2>/dev/null)
    USER_READ_ID=$(az ad sp show --id "$GRAPH_API" --query "oauth2PermissionScopes[?value=='User.Read'].id" -o tsv 2>/dev/null)
    MBOX_SETTINGS_ID=$(az ad sp show --id "$GRAPH_API" --query "oauth2PermissionScopes[?value=='MailboxSettings.Read'].id" -o tsv 2>/dev/null)
    USER_BASIC_ALL_ID=$(az ad sp show --id "$GRAPH_API" --query "oauth2PermissionScopes[?value=='User.ReadBasic.All'].id" -o tsv 2>/dev/null)

    az ad app permission add --id "$APP_ID" \
        --api "$GRAPH_API" \
        --api-permissions \
            "$MAIL_RW_ID=Scope" \
            "$MAIL_SEND_ID=Scope" \
            "$CAL_RW_ID=Scope" \
            "$USER_READ_ID=Scope" \
            "$MBOX_SETTINGS_ID=Scope" \
            "$USER_BASIC_ALL_ID=Scope" 2>/dev/null || true

    echo -e "${GREEN}✓ Permissions added:${NC}"
    echo "    Mail.ReadWrite, Mail.Send, Calendars.ReadWrite,"
    echo "    User.Read, MailboxSettings.Read, User.ReadBasic.All"
}

save_config() {
    if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
        echo -e "${RED}Refusing to write config: CLIENT_ID or CLIENT_SECRET is empty${NC}"
        exit 1
    fi

    mkdir -p "$CONFIG_DIR"

    if [ -f "$CONFIG_FILE" ]; then
        cp "$CONFIG_FILE" "$CONFIG_FILE.bak.$(date +%Y%m%d-%H%M%S)"
    fi

    echo ""
    echo -e "${YELLOW}Saving Configuration${NC}"

    # timezone is seeded empty and populated by test_connection (or
    # later by outlook-token.sh refresh) from /me/mailboxSettings.
    # Windows timezone format, e.g. "India Standard Time".
    cat > "$CONFIG_FILE" << EOF
{
  "client_id": "$CLIENT_ID",
  "client_secret": "$CLIENT_SECRET",
  "timezone": ""
}
EOF

    chmod 600 "$CONFIG_FILE"
    echo -e "${GREEN}✓ Config saved to $CONFIG_FILE${NC}"
}

authorize() {
    echo ""
    echo -e "${YELLOW}User Authorization${NC}"
    echo ""

    AUTH_URL="https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=$CLIENT_ID&response_type=code&redirect_uri=$REDIRECT_URI&scope=$(echo $SCOPES | sed 's/ /%20/g')&response_mode=query"

    echo "Open this URL in your browser:"
    echo ""
    echo -e "${BLUE}$AUTH_URL${NC}"
    echo ""
    echo "After authorizing, you'll be redirected to a page that won't load."
    echo "Copy the FULL URL from the address bar and paste it here:"
    echo ""
    read -p "URL: " REDIRECT_URL

    AUTH_CODE=$(echo "$REDIRECT_URL" | grep -oP 'code=\K[^&]+' || echo "")

    if [ -z "$AUTH_CODE" ]; then
        echo -e "${RED}Could not extract authorization code from URL${NC}"
        exit 1
    fi

    echo ""
    echo "Exchanging code for tokens..."

    # Use --data-urlencode to avoid putting the client_secret on curl's
    # command line where it would leak via /proc/<pid>/cmdline.
    TOKEN_RESPONSE=$(curl -s -X POST "https://login.microsoftonline.com/common/oauth2/v2.0/token" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        --data-urlencode "client_id=$CLIENT_ID" \
        --data-urlencode "client_secret=$CLIENT_SECRET" \
        --data-urlencode "code=$AUTH_CODE" \
        --data-urlencode "redirect_uri=$REDIRECT_URI" \
        --data-urlencode "grant_type=authorization_code" \
        --data-urlencode "scope=$SCOPES")

    if echo "$TOKEN_RESPONSE" | jq -e '.access_token' > /dev/null 2>&1; then
        if [ -f "$CREDS_FILE" ]; then
            cp "$CREDS_FILE" "$CREDS_FILE.bak.$(date +%Y%m%d-%H%M%S)"
        fi
        echo "$TOKEN_RESPONSE" > "$CREDS_FILE"
        chmod 600 "$CREDS_FILE"
        echo -e "${GREEN}✓ Tokens saved${NC}"
    else
        echo -e "${RED}Failed to get tokens:${NC}"
        echo "$TOKEN_RESPONSE" | jq '.error_description // .'
        exit 1
    fi
}

# Per-scope verification. Each check isolates one consent so failures
# point at exactly which scope didn't land. Inbox is hard-required;
# the other two warn but don't abort so setup still completes on
# tenants where admin consent for User.ReadBasic.All is pending.
test_connection() {
    echo ""
    echo -e "${YELLOW}Testing Connection${NC}"

    ACCESS_TOKEN=$(jq -r '.access_token' "$CREDS_FILE")

    # 1. Mail.ReadWrite — inbox access. Required.
    INBOX=$(curl -s "https://graph.microsoft.com/v1.0/me/mailFolders/inbox" \
        -H "Authorization: Bearer $ACCESS_TOKEN")

    if echo "$INBOX" | jq -e '.totalItemCount' > /dev/null 2>&1; then
        TOTAL=$(echo "$INBOX" | jq '.totalItemCount')
        UNREAD=$(echo "$INBOX" | jq '.unreadItemCount')
        echo -e "${GREEN}✓ Inbox access (Mail.ReadWrite)${NC}"
        echo -e "    ${BLUE}$TOTAL${NC} emails (${YELLOW}$UNREAD${NC} unread)"
    else
        echo -e "${RED}✗ Inbox access failed (Mail.ReadWrite)${NC}"
        echo "$INBOX" | jq '.error.message // .'
        exit 1
    fi

    # 2. MailboxSettings.Read — timezone caching. Warn-on-fail.
    MBOX_RESPONSE=$(curl -s "https://graph.microsoft.com/v1.0/me/mailboxSettings/timeZone" \
        -H "Authorization: Bearer $ACCESS_TOKEN")

    if echo "$MBOX_RESPONSE" | jq -e '.value' > /dev/null 2>&1; then
        TIMEZONE=$(echo "$MBOX_RESPONSE" | jq -r '.value')
        jq --arg tz "$TIMEZONE" '.timezone = $tz' "$CONFIG_FILE" > /tmp/outlook-config.json \
            && mv /tmp/outlook-config.json "$CONFIG_FILE"
        chmod 600 "$CONFIG_FILE"
        echo -e "${GREEN}✓ Mailbox settings (MailboxSettings.Read)${NC}"
        echo -e "    Timezone cached: ${BLUE}$TIMEZONE${NC}"
    else
        echo -e "${YELLOW}⚠ Mailbox settings access failed (MailboxSettings.Read)${NC}"
        echo "$MBOX_RESPONSE" | jq '.error.message // .'
        echo "    Timezone won't be cached. Re-run authorize with the scope consented,"
        echo "    or set ~/.outlook-mcp/config.json timezone field manually"
        echo "    (Windows format, e.g. \"India Standard Time\")."
    fi

    # 3. User.ReadBasic.All — people lookup. Warn-on-fail.
    PEOPLE_RESPONSE=$(curl -s "https://graph.microsoft.com/v1.0/users?\$top=1&\$select=displayName" \
        -H "Authorization: Bearer $ACCESS_TOKEN")

    if echo "$PEOPLE_RESPONSE" | jq -e '.value' > /dev/null 2>&1; then
        echo -e "${GREEN}✓ People lookup (User.ReadBasic.All)${NC}"
    else
        echo -e "${YELLOW}⚠ People lookup failed (User.ReadBasic.All)${NC}"
        echo "$PEOPLE_RESPONSE" | jq '.error.message // .'
        echo "    Work/school accounts may require admin consent for this scope."
        echo "    Person-by-name lookups in the agent will not work until granted."
    fi
}

# Cron jobs run scripts from the triage agent workspace ($TRIAGE_DIR),
# not this script's own dir. We're being invoked from the main agent's
# scripts/ dir during setup, but the scheduler drives the triage side.
setup_cron() {
    echo ""
    echo -e "${YELLOW}Setting up cron jobs${NC}"

    local missing=()
    for script in check-and-trigger.sh outlook-seen.sh; do
        if [ ! -x "$TRIAGE_DIR/$script" ]; then
            missing+=("$script")
        fi
    done
    if [ ${#missing[@]} -gt 0 ]; then
        echo -e "${YELLOW}⚠ Skipping cron setup — missing or non-executable in $TRIAGE_DIR:${NC}"
        for s in "${missing[@]}"; do echo "    $s"; done
        echo "    Make them executable (chmod +x) and re-run this script to register cron."
        return
    fi

    (crontab -l 2>/dev/null | grep -v "check-and-trigger\|outlook-seen.*prune"; \
     echo "* * * * * $TRIAGE_DIR/check-and-trigger.sh"; \
     echo "0 3 * * * $TRIAGE_DIR/outlook-seen.sh prune") | crontab -

    echo -e "${GREEN}✓ Cron jobs registered${NC}"
    echo "  - Email triage: every minute ($TRIAGE_DIR/check-and-trigger.sh)"
    echo "  - Seen store prune: daily at 3am ($TRIAGE_DIR/outlook-seen.sh prune)"
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
    authorize
    test_connection
    setup_cron

    echo ""
    echo -e "${GREEN}=== Setup Complete! ===${NC}"
    echo ""
    echo "You can now use:"
    echo "  outlook-mail.sh inbox          - List emails"
    echo "  outlook-mail.sh unread         - List unread"
    echo "  outlook-mail.sh search X       - Search emails"
    echo "  outlook-calendar.sh today      - Today's events"
    echo "  outlook-calendar.sh week       - This week's events"
    echo "  outlook-token.sh refresh       - Refresh token (also re-caches timezone)"
}

main "$@"