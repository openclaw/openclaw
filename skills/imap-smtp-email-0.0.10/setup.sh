#!/bin/bash

# IMAP/SMTP Email Skill Setup Helper

CONFIG_DIR="$HOME/.config/imap-smtp-email"
CONFIG_FILE="$CONFIG_DIR/.env"

echo "================================"
echo "  IMAP/SMTP Email Skill Setup"
echo "================================"
echo ""

# Determine setup mode
SETUP_MODE="default"
ACCOUNT_PREFIX=""
ACCOUNT_NAME=""

if [ -f "$CONFIG_FILE" ]; then
  echo "Existing configuration found at $CONFIG_FILE"
  echo ""
  echo "What would you like to do?"
  echo "  1) Reconfigure default account"
  echo "  2) Add a new account"
  echo ""
  read -p "Enter choice (1-2): " SETUP_CHOICE

  case $SETUP_CHOICE in
    1)
      SETUP_MODE="reconfigure"
      ;;
    2)
      SETUP_MODE="add"
      while true; do
        read -p "Account name (letters/digits only, e.g. work): " ACCOUNT_NAME
        if [[ "$ACCOUNT_NAME" =~ ^[a-zA-Z0-9]+$ ]]; then
          ACCOUNT_PREFIX="$(echo "$ACCOUNT_NAME" | tr '[:lower:]' '[:upper:]')_"
          # Check if account already exists
          if grep -q "^${ACCOUNT_PREFIX}IMAP_HOST=" "$CONFIG_FILE" 2>/dev/null; then
            read -p "Account \"$ACCOUNT_NAME\" already exists. Overwrite? (y/n): " OVERWRITE
            if [ "$OVERWRITE" != "y" ]; then
              echo "Aborted."
              exit 0
            fi
            SETUP_MODE="overwrite"
          fi
          break
        else
          echo "Invalid name. Use only letters and digits."
        fi
      done
      ;;
    *)
      echo "Invalid choice"
      exit 1
      ;;
  esac
fi

echo ""
echo "This script will help you configure email credentials."
echo ""

# Prompt for email provider
echo "Select your email provider:"
echo "  1) Gmail"
echo "  2) Outlook"
echo "  3) 163.com"
echo "  4) vip.163.com"
echo "  5) 126.com"
echo "  6) vip.126.com"
echo "  7) 188.com"
echo "  8) vip.188.com"
echo "  9) yeah.net"
echo " 10) QQ Mail"
echo " 11) Custom"
echo ""
read -p "Enter choice (1-11): " PROVIDER_CHOICE

case $PROVIDER_CHOICE in
  1)
    IMAP_HOST="imap.gmail.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.gmail.com"
    SMTP_PORT="587"
    SMTP_SECURE="false"
    IMAP_TLS="true"
    echo ""
    echo "⚠️  Gmail requires an App Password — your regular Google password will NOT work."
    echo "   1. Go to: https://myaccount.google.com/apppasswords"
    echo "   2. Generate an App Password (requires 2-Step Verification enabled)"
    echo "   3. Use the generated 16-character password below"
    echo ""
    ;;
  2)
    IMAP_HOST="outlook.office365.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.office365.com"
    SMTP_PORT="587"
    SMTP_SECURE="false"
    IMAP_TLS="true"
    ;;
  3)
    IMAP_HOST="imap.163.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.163.com"
    SMTP_PORT="465"
    SMTP_SECURE="true"
    IMAP_TLS="true"
    ;;
  4)
    IMAP_HOST="imap.vip.163.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.vip.163.com"
    SMTP_PORT="465"
    SMTP_SECURE="true"
    IMAP_TLS="true"
    ;;
  5)
    IMAP_HOST="imap.126.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.126.com"
    SMTP_PORT="465"
    SMTP_SECURE="true"
    IMAP_TLS="true"
    ;;
  6)
    IMAP_HOST="imap.vip.126.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.vip.126.com"
    SMTP_PORT="465"
    SMTP_SECURE="true"
    IMAP_TLS="true"
    ;;
  7)
    IMAP_HOST="imap.188.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.188.com"
    SMTP_PORT="465"
    SMTP_SECURE="true"
    IMAP_TLS="true"
    ;;
  8)
    IMAP_HOST="imap.vip.188.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.vip.188.com"
    SMTP_PORT="465"
    SMTP_SECURE="true"
    IMAP_TLS="true"
    ;;
  9)
    IMAP_HOST="imap.yeah.net"
    IMAP_PORT="993"
    SMTP_HOST="smtp.yeah.net"
    SMTP_PORT="465"
    SMTP_SECURE="true"
    IMAP_TLS="true"
    ;;
  10)
    IMAP_HOST="imap.qq.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.qq.com"
    SMTP_PORT="587"
    SMTP_SECURE="false"
    IMAP_TLS="true"
    ;;
  11)
    read -p "IMAP Host: " IMAP_HOST
    read -p "IMAP Port: " IMAP_PORT
    read -p "SMTP Host: " SMTP_HOST
    read -p "SMTP Port: " SMTP_PORT
    read -p "Use TLS for IMAP? (true/false): " IMAP_TLS
    read -p "Use SSL for SMTP? (true/false): " SMTP_SECURE
    ;;
  *)
    echo "Invalid choice"
    exit 1
    ;;
esac

echo ""
read -p "Email address: " EMAIL
read -s -p "Password / App Password / Authorization Code: " PASSWORD
echo ""
read -p "Accept self-signed certificates? (y/n): " ACCEPT_CERT
if [ "$ACCEPT_CERT" = "y" ]; then
  REJECT_UNAUTHORIZED="false"
else
  REJECT_UNAUTHORIZED="true"
fi

# Only ask for shared settings on first-time or reconfigure
ASK_SHARED=false
if [ "$SETUP_MODE" = "default" ] || [ "$SETUP_MODE" = "reconfigure" ]; then
  ASK_SHARED=true
fi

if [ "$ASK_SHARED" = true ]; then
  read -p "Allowed directories for reading files (comma-separated, e.g. ~/Downloads,~/Documents): " ALLOWED_READ_DIRS
  read -p "Allowed directories for saving attachments (comma-separated, e.g. ~/Downloads): " ALLOWED_WRITE_DIRS
fi

# Create config directory
mkdir -p -m 700 "$CONFIG_DIR"

# Build account variables block
ACCOUNT_VARS="# ${ACCOUNT_NAME:-Default} account
${ACCOUNT_PREFIX}IMAP_HOST=$IMAP_HOST
${ACCOUNT_PREFIX}IMAP_PORT=$IMAP_PORT
${ACCOUNT_PREFIX}IMAP_USER=$EMAIL
${ACCOUNT_PREFIX}IMAP_PASS=$PASSWORD
${ACCOUNT_PREFIX}IMAP_TLS=$IMAP_TLS
${ACCOUNT_PREFIX}IMAP_REJECT_UNAUTHORIZED=$REJECT_UNAUTHORIZED
${ACCOUNT_PREFIX}IMAP_MAILBOX=INBOX
${ACCOUNT_PREFIX}SMTP_HOST=$SMTP_HOST
${ACCOUNT_PREFIX}SMTP_PORT=$SMTP_PORT
${ACCOUNT_PREFIX}SMTP_SECURE=$SMTP_SECURE
${ACCOUNT_PREFIX}SMTP_USER=$EMAIL
${ACCOUNT_PREFIX}SMTP_PASS=$PASSWORD
${ACCOUNT_PREFIX}SMTP_FROM=$EMAIL
${ACCOUNT_PREFIX}SMTP_REJECT_UNAUTHORIZED=$REJECT_UNAUTHORIZED"

case $SETUP_MODE in
  "default")
    # First-time setup: write entire file
    cat > "$CONFIG_FILE" << EOF
$ACCOUNT_VARS

# File access whitelist (security)
ALLOWED_READ_DIRS=${ALLOWED_READ_DIRS:-$HOME/Downloads,$HOME/Documents}
ALLOWED_WRITE_DIRS=${ALLOWED_WRITE_DIRS:-$HOME/Downloads}
EOF
    ;;
  "reconfigure")
    # Keep only named-account lines (pattern: NAME_IMAP_* or NAME_SMTP_*)
    TEMP_FILE=$(mktemp)
    grep -E '^[A-Z0-9]+_(IMAP_|SMTP_)' "$CONFIG_FILE" > "$TEMP_FILE.named" 2>/dev/null || true

    cat > "$TEMP_FILE" << EOF
$ACCOUNT_VARS

# File access whitelist (security)
ALLOWED_READ_DIRS=${ALLOWED_READ_DIRS:-$HOME/Downloads,$HOME/Documents}
ALLOWED_WRITE_DIRS=${ALLOWED_WRITE_DIRS:-$HOME/Downloads}
EOF

    # Append retained named-account lines if any
    if [ -s "$TEMP_FILE.named" ]; then
      echo "" >> "$TEMP_FILE"
      echo "# Named accounts" >> "$TEMP_FILE"
      cat "$TEMP_FILE.named" >> "$TEMP_FILE"
    fi
    mv "$TEMP_FILE" "$CONFIG_FILE"
    rm -f "$TEMP_FILE.named"
    ;;
  "add")
    # Append named account to existing file
    echo "" >> "$CONFIG_FILE"
    echo "$ACCOUNT_VARS" >> "$CONFIG_FILE"
    ;;
  "overwrite")
    # Strip existing lines with this account prefix, then append new ones
    TEMP_FILE=$(mktemp)
    grep -v "^${ACCOUNT_PREFIX}\(IMAP_\|SMTP_\)" "$CONFIG_FILE" | grep -vi "^# ${ACCOUNT_NAME} account" > "$TEMP_FILE" 2>/dev/null || true
    # Remove trailing blank lines (portable: command substitution strips trailing newlines)
    content=$(cat "$TEMP_FILE") && printf '%s\n' "$content" > "$TEMP_FILE"
    echo "" >> "$TEMP_FILE"
    echo "$ACCOUNT_VARS" >> "$TEMP_FILE"
    mv "$TEMP_FILE" "$CONFIG_FILE"
    ;;
esac

echo ""
echo "✅ Configuration saved to $CONFIG_FILE"
chmod 600 "$CONFIG_FILE"
echo "✅ Set file permissions to 600 (owner read/write only)"
echo ""
echo "Testing connections..."
echo ""

# Build test command with account flag if applicable
ACCOUNT_FLAG=""
if [ -n "$ACCOUNT_NAME" ]; then
  ACCOUNT_FLAG="--account $ACCOUNT_NAME"
fi

# Test IMAP connection
echo "Testing IMAP..."
if node scripts/imap.js $ACCOUNT_FLAG list-mailboxes >/dev/null 2>&1; then
    echo "✅ IMAP connection successful!"
else
    echo "❌ IMAP connection test failed"
    echo "   Please check your credentials and settings"
fi

# Test SMTP connection
echo ""
echo "Testing SMTP..."
echo "  (This will send a test email to your own address: $EMAIL)"
if node scripts/smtp.js $ACCOUNT_FLAG test >/dev/null 2>&1; then
    echo "✅ SMTP connection successful!"
else
    echo "❌ SMTP connection test failed"
    echo "   Please check your credentials and settings"
fi

echo ""
echo "Setup complete! Try:"
if [ -n "$ACCOUNT_NAME" ]; then
  echo "  node scripts/imap.js --account $ACCOUNT_NAME check"
  echo "  node scripts/smtp.js --account $ACCOUNT_NAME send --to recipient@example.com --subject Test --body 'Hello World'"
else
  echo "  node scripts/imap.js check"
  echo "  node scripts/smtp.js send --to recipient@example.com --subject Test --body 'Hello World'"
fi
