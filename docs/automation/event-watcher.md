---
summary: "Lightweight polling for cost-efficient event monitoring"
read_when:
  - Setting up email or calendar notifications
  - Reducing heartbeat API costs
  - Building custom monitoring integrations
---

# Event Watcher

Event Watcher is a **zero-LLM-cost** polling system that monitors external services
and wakes Clawdbot only when there's something new to process.

## Why Use This?

The heartbeat system makes an LLM API call on every iteration, even when nothing
needs attention. Event Watcher provides an alternative:

| Approach | Check Cost | Wake Cost |
|----------|------------|-----------|
| Heartbeat only | ~$0.01-0.10 per check | N/A |
| Event Watcher | ~$0.00 (just API calls) | Only when needed |

For email monitoring with 30-second checks, Event Watcher can reduce costs by 80-90%.

## How It Works

```
Event Watcher (no LLM)
    │
    ├─→ Check Gmail API (unread count)
    ├─→ Check Calendar API (upcoming events)
    ├─→ Check other sources...
    │
    ▼
Something new? ─── No ──→ Sleep, repeat
    │
   Yes
    │
    ▼
clawdbot system event --mode now --text "New email from..."
    │
    ▼
Clawdbot wakes (LLM call)
```

## Installation

```bash
# From the moltbot repo
cd scripts/event-watcher
./install.sh

# Or manually:
mkdir -p ~/.clawdbot/scripts/watchers
cp event-watcher.sh ~/.clawdbot/scripts/
cp watchers/*.py ~/.clawdbot/scripts/watchers/
chmod +x ~/.clawdbot/scripts/*.sh ~/.clawdbot/scripts/watchers/*.py

# Create config
cp event-watcher.json5.example ~/.clawdbot/event-watcher.json5
```

## Configuration

Edit `~/.clawdbot/event-watcher.json5`:

```json5
{
  "pollIntervalSeconds": 30,
  "wakeMode": "now",
  
  "watchers": {
    "gmail": {
      "enabled": true,
      "credentialsFile": "~/.clawdbot/credentials/google-tokens.json"
    }
  }
}
```

## Running

### Manual Check
```bash
~/.clawdbot/scripts/event-watcher.sh
```

### Continuous Loop
```bash
~/.clawdbot/scripts/event-watcher.sh --loop
```

### As Daemon
```bash
~/.clawdbot/scripts/event-watcher.sh --daemon
~/.clawdbot/scripts/event-watcher.sh --status
~/.clawdbot/scripts/event-watcher.sh --stop
```

### Via launchd (macOS)

Create `~/Library/LaunchAgents/com.clawdbot.event-watcher.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.clawdbot.event-watcher</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USER/.clawdbot/scripts/event-watcher.sh</string>
        <string>--loop</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USER/.clawdbot/logs/event-watcher.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USER/.clawdbot/logs/event-watcher.log</string>
</dict>
</plist>
```

Then:
```bash
launchctl load ~/Library/LaunchAgents/com.clawdbot.event-watcher.plist
```

### Via systemd (Linux)

Create `~/.config/systemd/user/clawdbot-event-watcher.service`:

```ini
[Unit]
Description=Clawdbot Event Watcher
After=network.target

[Service]
Type=simple
ExecStart=%h/.clawdbot/scripts/event-watcher.sh --loop
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Then:
```bash
systemctl --user enable --now clawdbot-event-watcher
```

## Built-in Watchers

### Gmail
Monitors for new unread emails.

```json5
"gmail": {
  "enabled": true,
  "credentialsFile": "~/.clawdbot/credentials/google-tokens.json",
  "filters": {
    "excludeLabels": ["CATEGORY_PROMOTIONS"]
  }
}
```

### Google Calendar
Alerts when events are approaching.

```json5
"calendar": {
  "enabled": true,
  "lookaheadMinutes": 15,
  "ignoreAllDay": true
}
```

## Custom Watchers

See [Adding Watchers](./adding-watchers.md) for how to monitor custom sources.

## Coexistence with Heartbeat

Event Watcher complements heartbeats rather than replacing them:

- **Event Watcher**: Time-sensitive, high-frequency checks (email, alerts)
- **Heartbeat**: Periodic maintenance, memory review, batch operations

Recommended setup:
- Event Watcher: 30s interval, always running
- Heartbeat: 2-4 hour interval for periodic tasks

## Troubleshooting

### Debug Mode
```bash
EVENT_WATCHER_DEBUG=1 ./event-watcher.sh
```

### Check Logs
```bash
tail -f ~/.clawdbot/logs/event-watcher.log
```

### View State
```bash
cat ~/.clawdbot/event-watcher-state.json | jq .
```

### Test Wake
```bash
clawdbot system event --mode now --text "Test wake from event watcher"
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `EVENT_WATCHER_CONFIG` | Override config file path |
| `EVENT_WATCHER_DEBUG` | Enable debug output (1 = on) |
