---
name: moonpay-price-alerts
description: Set up desktop price alerts that notify you when tokens hit target prices. Observe-only — no trading, just notifications.
tags: [alerts, research]
metadata: { "openclaw": { "requires": { "bins": ["mp"] } } }
---

# Price alerts

## Goal

Monitor token prices and get desktop notifications when they cross a threshold. Uses `mp token retrieve` for price checks and OS notifications (`osascript`/`notify-send`) for alerts. Observe-only — no funds at risk.

## Prerequisites

- `mp` binary on PATH: `which mp`
- `jq` installed: `which jq`
- macOS: `osascript` (built-in) or Linux: `notify-send` (`sudo apt install libnotify-bin`)

## One-shot alert

"Tell me when SOL drops below $80" — checks every 5 minutes, fires once, then disables itself.

### Script: `~/.config/moonpay/scripts/alert-sol-below-80.sh`

```bash
#!/bin/bash
set -euo pipefail

MP="$(which mp)"
LOG="$HOME/.config/moonpay/logs/alerts.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }

# --- Config ---
TOKEN="So11111111111111111111111111111111111111111"
CHAIN="solana"
SYMBOL="SOL"
TARGET=80
DIRECTION="below"  # "above" or "below"
SCRIPT_NAME="alert-sol-below-80"

# --- Check price ---
PRICE=$("$MP" -f compact token retrieve --token "$TOKEN" --chain "$CHAIN" | jq -r '.marketData.price')

if [ -z "$PRICE" ] || [ "$PRICE" = "null" ]; then
  log "ALERT $SCRIPT_NAME: price fetch failed, skipping"
  exit 0
fi

# --- Compare ---
TRIGGERED=false
if [ "$DIRECTION" = "below" ] && (( $(echo "$PRICE < $TARGET" | bc -l) )); then
  TRIGGERED=true
elif [ "$DIRECTION" = "above" ] && (( $(echo "$PRICE > $TARGET" | bc -l) )); then
  TRIGGERED=true
fi

if [ "$TRIGGERED" = true ]; then
  MSG="$SYMBOL is $DIRECTION \$$TARGET — currently \$$PRICE"
  log "ALERT $SCRIPT_NAME: $MSG"

  # Desktop notification
  if [[ "$OSTYPE" == "darwin"* ]]; then
    osascript -e "display notification \"$MSG\" with title \"MoonPay Alert\" sound name \"Glass\""
  else
    notify-send "MoonPay Alert" "$MSG"
  fi

  # Self-disable (one-shot)
  if [[ "$OSTYPE" == "darwin"* ]]; then
    launchctl unload "$HOME/Library/LaunchAgents/com.moonpay.${SCRIPT_NAME}.plist" 2>/dev/null || true
  else
    crontab -l | grep -v "$SCRIPT_NAME" | crontab -
  fi
  log "ALERT $SCRIPT_NAME: disabled after trigger"
else
  log "ALERT $SCRIPT_NAME: $SYMBOL at \$$PRICE — not triggered ($DIRECTION $TARGET)"
fi
```

### Schedule

Check every 5 minutes:

```bash
# cron (Linux)
*/5 * * * * ~/.config/moonpay/scripts/alert-sol-below-80.sh # moonpay:alert-sol-below-80

# launchd (macOS) — use StartInterval of 300 seconds in the plist
```

Launchd plist at `~/Library/LaunchAgents/com.moonpay.alert-sol-below-80.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.moonpay.alert-sol-below-80</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/USERNAME/.config/moonpay/scripts/alert-sol-below-80.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>StandardErrorPath</key>
  <string>/Users/USERNAME/.config/moonpay/logs/alert-sol-below-80.err</string>
</dict>
</plist>
```

Load: `launchctl load ~/Library/LaunchAgents/com.moonpay.alert-sol-below-80.plist`

**Important:** Replace `USERNAME` with the actual username. Tilde does not expand in plist files.

## Recurring alert

"Alert me every hour while ETH is above $2000" — keeps firing on each check, doesn't self-disable.

Same script as above but remove the self-disable block. The alert fires every time the condition is met, until the user manually removes it.

## Managing alerts

### List active alerts

```bash
# macOS
launchctl list | grep moonpay

# Linux
crontab -l | grep moonpay
```

### Remove an alert

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.moonpay.alert-sol-below-80.plist
rm ~/Library/LaunchAgents/com.moonpay.alert-sol-below-80.plist

# Linux
crontab -l | grep -v "alert-sol-below-80" | crontab -
```

### View alert history

```bash
tail -50 ~/.config/moonpay/logs/alerts.log
```

## Tips

- Price checks via `mp token retrieve` are free — no gas costs
- 5-minute intervals are reasonable; don't go below 1 minute
- Use `mp token search --query "SOL" --chain solana` to resolve token addresses
- Alerts log to `~/.config/moonpay/logs/alerts.log` — check this to verify they're running
- The machine must be logged in for notifications and keychain access to work
- `bc -l` handles decimal comparison; if unavailable, use `awk "BEGIN {exit !($PRICE < $TARGET)}"`
- This skill is observe-only — for automated buying/selling, see **moonpay-trading-automation**

## Related skills

- **moonpay-trading-automation** — Automated trading (DCA, limit orders, stop losses)
- **moonpay-discover-tokens** — Research tokens and get current prices
- **moonpay-check-wallet** — Check portfolio before setting alerts
