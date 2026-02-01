# Event Watcher - Lightweight Polling for Clawdbot

A cost-efficient polling system that monitors external services (Gmail, calendars, etc.) 
and wakes Clawdbot only when there's something new to process.

## The Problem

Clawdbot's heartbeat makes an LLM API call on every iteration, even when nothing needs 
attention. This adds up quickly at $0.01-0.10+ per heartbeat.

## The Solution

Event Watcher is a **zero-LLM-cost** polling loop that:
1. Checks configured sources (Gmail, Matrix, etc.) using lightweight API calls
2. Compares to previous state
3. Only wakes Clawdbot when something changed

Think of it like `select()` in C — it waits for "file descriptors" to be ready, 
then signals which ones need attention.

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  Event Watcher (no LLM calls)                               │
│                                                             │
│  ┌─────────┐   ┌─────────┐   ┌─────────┐                   │
│  │  Gmail  │   │  Matrix │   │ Calendar│   ... (plugins)   │
│  └────┬────┘   └────┬────┘   └────┬────┘                   │
│       │             │             │                         │
│       └─────────────┼─────────────┘                         │
│                     ▼                                       │
│              Compare to state                               │
│                     │                                       │
│       ┌─────────────┴─────────────┐                        │
│       ▼                           ▼                        │
│   No change                   Something new!               │
│   (sleep 30s)                       │                      │
│                                     ▼                      │
│                     clawdbot system event --mode now       │
│                     --text "New email from sender@..."     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │    Clawdbot     │
                    │  (LLM call now) │
                    └─────────────────┘
```

## Installation

```bash
# Copy to clawdbot scripts
cp event-watcher.sh ~/.clawdbot/scripts/
cp event-watcher.json5.example ~/.clawdbot/event-watcher.json5

# Edit your config
$EDITOR ~/.clawdbot/event-watcher.json5

# Run manually to test
~/.clawdbot/scripts/event-watcher.sh

# Or add to cron (check every 30 seconds)
# Note: For sub-minute intervals, use a loop or systemd timer
```

## Configuration

Edit `~/.clawdbot/event-watcher.json5`:

```json5
{
  // Global settings
  "pollIntervalSeconds": 30,
  "stateFile": "~/.clawdbot/event-watcher-state.json",
  
  // Wake mode: "now" (immediate) or "next-heartbeat" (wait for scheduled)
  "wakeMode": "now",
  
  // Watchers to enable
  "watchers": {
    "gmail": {
      "enabled": true,
      "credentialsFile": "~/.clawdbot/credentials/google-tokens.json",
      // Only wake for emails matching these criteria (optional)
      "filters": {
        "fromDomains": [],  // e.g., ["important.com"]
        "excludeLabels": ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"]
      }
    },
    
    "calendar": {
      "enabled": false,
      "credentialsFile": "~/.clawdbot/credentials/google-tokens.json",
      "lookaheadMinutes": 15  // Wake when event is this close
    },
    
    // Add your own watchers here!
    // See docs/adding-watchers.md for examples
  }
}
```

## Coexistence with Heartbeat

Event Watcher is designed to **complement** heartbeats, not replace them:

| Use Event Watcher for... | Use Heartbeat for... |
|--------------------------|----------------------|
| Email monitoring | Periodic memory review |
| Time-sensitive alerts | Multi-source batch checks |
| High-frequency checks | Tasks needing conversation context |

You can run both: Event Watcher handles urgent notifications, 
heartbeat handles scheduled maintenance.

## Cost Comparison

| Approach | Checks/day | LLM Calls/day | Est. Cost* |
|----------|------------|---------------|------------|
| Heartbeat only (30min) | 48 | 48 | ~$0.50-5.00 |
| Event Watcher + Heartbeat (2hr) | 2880 + 12 | ~5-20 + 12 | ~$0.10-0.50 |

*Depends on model, context size, and how many events trigger wakes.

## Writing Custom Watchers

See [docs/adding-watchers.md](docs/adding-watchers.md) for how to add your own sources.

## Files

```
clawdbot-event-watcher/
├── README.md                           # This file
├── event-watcher.sh                    # Main script
├── event-watcher.json5.example         # Example configuration
├── install.sh                          # One-command installer
├── com.clawdbot.event-watcher.plist    # macOS launchd service
├── clawdbot-event-watcher.service      # Linux systemd service
├── docs/
│   ├── event-watcher.md                # Full documentation
│   └── adding-watchers.md              # Guide for custom watchers
└── watchers/
    └── gmail-check.py                  # Gmail API checker
```

## Requirements

- **jq** - JSON processing (`brew install jq` / `apt install jq`)
- **clawdbot** or **moltbot** CLI in PATH
- **Python 3** with google-auth libraries (for Gmail watcher):
  ```bash
  pip install google-auth google-auth-oauthlib google-api-python-client
  ```

## License

MIT - Same as Clawdbot
