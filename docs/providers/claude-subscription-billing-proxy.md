---
summary: "Community proxy to route OpenClaw API requests through Claude subscription billing"
read_when:
  - You want to use Claude Max/Pro subscription with OpenClaw agents
  - OpenClaw returns 402 "extra usage" errors with valid subscription
  - You want subscription billing instead of pay-per-token for Claude
title: "Claude Subscription Billing Proxy"
---

# Claude Subscription Billing Proxy

Configure OpenClaw to use your Claude Max or Pro subscription billing instead of extra usage by routing API requests through a local proxy that normalizes request payloads.

<Warning>
**Review the source code before running.** This is a community tool, not
officially supported by Anthropic or OpenClaw. Before running `node setup.js`
or `node proxy.js`, inspect the
[proxy source code](https://github.com/zacdcook/openclaw-billing-proxy/blob/main/proxy.js)
(single-file, zero dependencies) and understand what it does:

- **OAuth token access:** The setup script reads your Claude Code OAuth token
  from the macOS Keychain (or `~/.claude/.credentials.json`). This token grants
  API access to your Claude subscription.
- **Traffic interception:** All Anthropic API requests — including full
  conversation content, system prompts, and tool calls — pass through the
  proxy process on `localhost:18801`.
- **Local only:** The proxy runs entirely on your machine. No data is sent to
  third-party servers. The source is a single `proxy.js` file you can audit
  in full.
  </Warning>

## Why use this?

| Approach                    | Billing                     | Status                            |
| --------------------------- | --------------------------- | --------------------------------- |
| Direct `anthropic/*` models | Extra usage (pay per token) | 402 errors for subscription users |
| Via billing proxy           | Subscription included       | Works with Max/Pro plans          |
| `claude-cli/*` models       | Subscription via CLI        | Limited to CLI backend path       |

## Prerequisites

- **Claude Max or Pro subscription** (active)
- **Claude Code CLI** installed and authenticated (`claude auth login`)
- **Node.js 18+**
- **OpenClaw** installed and running

## Setup

### 1. Install the proxy

```bash
git clone https://github.com/zacdcook/openclaw-billing-proxy
cd openclaw-billing-proxy
node setup.js
```

The setup script automatically:

- Detects your Claude Code credentials (from macOS Keychain or `~/.claude/`)
- Generates a `config.json` with default sanitization rules
- Validates your subscription status

### 2. Start the proxy

```bash
node proxy.js
```

The proxy listens on `http://127.0.0.1:18801` by default. You should see:

```
OpenClaw Billing Proxy v2.x.x
Port:              18801
Subscription:      max
Token expires:     Xh
```

### 3. Configure OpenClaw

Update your `~/.openclaw/openclaw.json` to route Anthropic API requests through the proxy:

```json
{
  "models": {
    "providers": {
      "anthropic": {
        "baseUrl": "http://127.0.0.1:18801",
        "models": []
      }
    }
  }
}
```

### 4. Set agent models to use Anthropic

Update your agent model configuration to use `anthropic/claude-opus-4-6` or `anthropic/claude-sonnet-4-6`:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-6",
        "fallbacks": ["anthropic/claude-sonnet-4-6", "google-gemini-cli/gemini-3-pro-preview"]
      }
    }
  }
}
```

Update per-agent model overrides in `agents.list[]` as well if you have any.

### 5. Restart the gateway

```bash
openclaw gateway stop
openclaw gateway
```

### 6. Verify

Send a test message through any channel (Slack, Telegram, or the `/v1/chat/completions` endpoint). Check the proxy console for `200` responses:

```
[12:00:00] #1 POST /v1/messages (83714b -> 41274b)
[12:00:00] #1 > 200
```

## Token refresh

The Claude Code OAuth token expires periodically (typically every 8-12 hours). To refresh:

1. Open any Claude Code CLI session (this refreshes the keychain credential)
2. Re-run `node setup.js` in the proxy directory (extracts the fresh token)
3. The proxy picks up the new token automatically on next request

Alternatively, keep a Claude Code session open — the token refreshes automatically.

## Running the proxy as a service

For persistent operation, run the proxy as a background service:

**macOS (launchd):**

```bash
# Create a simple launch agent
cat > ~/Library/LaunchAgents/com.openclaw.billing-proxy.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.openclaw.billing-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/openclaw-billing-proxy/proxy.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/billing-proxy.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/billing-proxy.err.log</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.openclaw.billing-proxy.plist
```

**Linux (systemd):**

```bash
# Create a systemd user service
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/openclaw-billing-proxy.service << EOF
[Unit]
Description=OpenClaw Billing Proxy
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/openclaw-billing-proxy/proxy.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user enable --now openclaw-billing-proxy
```

## Rollback

To stop using the proxy and revert to direct API access:

1. Remove or change `baseUrl` in `~/.openclaw/openclaw.json`:
   ```json
   {
     "models": {
       "providers": {
         "anthropic": {
           "baseUrl": "https://api.anthropic.com",
           "models": []
         }
       }
     }
   }
   ```
2. Switch agent models back to non-Anthropic providers (e.g., `openai-codex/gpt-5.4`)
3. Restart the gateway

## Troubleshooting

### Proxy shows no requests

Verify `baseUrl` in `openclaw.json` points to `http://127.0.0.1:18801` and restart the gateway.

### 401 authentication errors

Your Claude Code token may have expired. Run `claude auth login` to refresh, then `node setup.js` in the proxy directory.

### 402 "extra usage" errors through the proxy

The proxy's sanitization patterns may need updating. Check for new OpenClaw tool names or system prompt changes. Run `node troubleshoot.js` in the proxy directory.

## Related

<CardGroup cols={2}>
  <Card title="Claude Max API Proxy" href="/providers/claude-max-api-proxy" icon="bolt">
    OpenAI-compatible proxy that wraps Claude Code CLI.
  </Card>
  <Card title="Anthropic provider" href="/providers/anthropic" icon="robot">
    Native OpenClaw integration with Claude CLI or API keys.
  </Card>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Overview of all providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference.
  </Card>
</CardGroup>

**External links:**

- [openclaw-billing-proxy source](https://github.com/zacdcook/openclaw-billing-proxy)
- [Billing classification investigation](https://github.com/anthropics/claude-code/issues/46262)
- [CLI automation billing discussion](https://github.com/anthropics/claude-code/issues/43556)
