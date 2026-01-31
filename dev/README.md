# Local Development Environment

This directory contains an isolated OpenClaw setup for development and testing.

## Quick Start

```bash
# 1. Set up the dev environment
./dev/setup.sh

# 2. Start the gateway
./dev/start.sh

# 3. (Optional) Start the mock Cursor API
./dev/mock-cursor.sh
```

## Directory Structure

```
dev/
├── README.md           # This file
├── setup.sh           # Initial setup script
├── start.sh           # Start gateway with dev config
├── mock-cursor.sh     # Start mock Cursor API server
├── test-cursor.sh     # Test Cursor Agent integration
├── config/            # Dev configuration (gitignored)
│   └── openclaw.json  # Local config
├── data/              # Dev data directory (gitignored)
│   ├── credentials/   # Auth credentials
│   ├── sessions/      # Session data
│   └── logs/          # Gateway logs
└── .env               # Environment variables (gitignored)
```

## Isolation

This setup is completely isolated from your global OpenClaw installation:

| Component    | Global                      | Dev                          |
| ------------ | --------------------------- | ---------------------------- |
| Config       | `~/.openclaw/openclaw.json` | `./dev/config/openclaw.json` |
| Data         | `~/.openclaw/`              | `./dev/data/`                |
| Gateway Port | 18789                       | 18790                        |
| Credentials  | `~/.openclaw/credentials/`  | `./dev/data/credentials/`    |

## Configuration

Edit `dev/config/openclaw.json` to configure channels. The Cursor Agent extension is pre-configured with placeholder values.

### Adding Your Cursor API Key

1. Get your API key from https://cursor.com/dashboard?tab=background-agents
2. Edit `dev/config/openclaw.json`:
   ```json
   {
     "channels": {
       "cursorAgent": {
         "accounts": {
           "default": {
             "apiKey": "YOUR_REAL_API_KEY_HERE"
           }
         }
       }
     }
   }
   ```

### Using Mock Cursor API

For testing without a real API key:

```bash
# Terminal 1: Start mock server
./dev/mock-cursor.sh

# Terminal 2: Start gateway (auto-configured to use mock)
CURSOR_API_BASE_URL=http://localhost:3456 ./dev/start.sh
```

## Testing

### Test via CLI

```bash
# Send a message to Cursor Agent
./dev/test-cursor.sh "Add a README file" https://github.com/test/repo

# List agents
./dev/test-cursor.sh list
```

### Test via WebChat

1. Start the gateway: `./dev/start.sh`
2. Open http://localhost:18790 in your browser
3. Send a message in the chat

## Cleanup

To remove all dev data:

```bash
rm -rf dev/config dev/data dev/.env
```

## Troubleshooting

### Port already in use

```bash
# Find and kill process using port 18790
lsof -i :18790
kill -9 <PID>
```

### Reset dev environment

```bash
rm -rf dev/config dev/data dev/.env
./dev/setup.sh
```
