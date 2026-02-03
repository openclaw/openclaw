#!/bin/bash
# Start Cloudflare quick tunnel and register Telegram webhook.
# The quick tunnel gives a random *.trycloudflare.com URL.
# We parse it and tell Telegram to send updates there.
set -euo pipefail

WEBHOOK_PORT="${WEBHOOK_PORT:-8787}"
WEBHOOK_PATH="${WEBHOOK_PATH:-/telegram-webhook}"
BOT_TOKEN="${BOT_TOKEN:-$(moltbot config get channels.telegram.botToken 2>/dev/null | tr -d '"')}"
LOG_FILE="${HOME}/.clawdbot/logs/tunnel.log"
TUNNEL_URL_FILE="${HOME}/.clawdbot/tunnel-url.txt"

if [ -z "$BOT_TOKEN" ]; then
  echo "ERROR: No bot token found"
  exit 1
fi

echo "[$(date)] Starting Cloudflare tunnel → localhost:${WEBHOOK_PORT}" >> "$LOG_FILE"

# Start tunnel in background, capture URL
cloudflared tunnel --url "http://localhost:${WEBHOOK_PORT}" --no-autoupdate 2>&1 | while IFS= read -r line; do
  echo "$line" >> "$LOG_FILE"
  # Parse the tunnel URL from cloudflared output
  if echo "$line" | grep -qoE 'https://[a-z0-9-]+\.trycloudflare\.com'; then
    TUNNEL_URL=$(echo "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com')
    FULL_URL="${TUNNEL_URL}${WEBHOOK_PATH}"
    echo "$FULL_URL" > "$TUNNEL_URL_FILE"
    echo "[$(date)] Tunnel URL: ${FULL_URL}" >> "$LOG_FILE"
    
    # Register webhook with Telegram
    RESULT=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${FULL_URL}")
    echo "[$(date)] setWebhook result: ${RESULT}" >> "$LOG_FILE"
    
    # Update moltbot config
    moltbot config set channels.telegram.webhookUrl "$FULL_URL" 2>/dev/null || true
    echo "[$(date)] Config updated, restarting gateway..." >> "$LOG_FILE"
    moltbot gateway restart --reason "Webhook URL updated: ${TUNNEL_URL}" 2>/dev/null || true
  fi
done
