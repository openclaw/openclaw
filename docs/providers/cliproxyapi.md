---
summary: "Use CLIProxyAPI to route Claude Max/Pro subscription traffic through OpenClaw via OAuth"
read_when:
  - You want to use CLIProxyAPI as a local Claude proxy for OpenClaw
  - You want a Go-based proxy that calls the Anthropic API directly via OAuth
  - You want to configure OpenClaw with a custom OpenAI-compatible provider backed by Claude subscription
title: "CLIProxyAPI"
---

# CLIProxyAPI

**CLIProxyAPI** is a Go-based proxy that exposes your Claude Max/Pro subscription as an OpenAI-compatible API endpoint. Unlike [claude-max-api-proxy](/providers/claude-max-api-proxy) which wraps the Claude Code CLI as a subprocess, CLIProxyAPI calls the Anthropic API directly using OAuth tokens, resulting in lower latency and no Node.js dependency.

## Why Use This?

| Approach | How it works | Pros |
| --- | --- | --- |
| [claude-max-api-proxy](/providers/claude-max-api-proxy) | Wraps Claude Code CLI (Node.js subprocess) | Simple npm install |
| **CLIProxyAPI** | Direct Anthropic API calls via OAuth (Go binary) | Lower latency, no subprocess overhead, multi-model support |
| [Anthropic API key](/providers/anthropic) | Official API with pay-per-token | No proxy needed, production-grade |

CLIProxyAPI is ideal when you have a Claude Max/Pro subscription and want the best performance from a local proxy.

## How It Works

```
Your App / OpenClaw Gateway
        |
        v
CLIProxyAPI (localhost:3456)
        |  reads OAuth token from ~/.config/claude/
        v
Anthropic API (direct HTTPS, no CLI subprocess)
```

The proxy:

1. Reads your OAuth credentials from `~/.config/claude/` (stored by `claude auth login`)
2. Accepts OpenAI-format requests at `http://localhost:3456/v1/chat/completions`
3. Translates and forwards them directly to the Anthropic API
4. Returns responses in OpenAI format (streaming supported)

## Installation

```bash
# macOS (Homebrew)
brew install cliproxyapi

# Authenticate Claude (first time only)
cliproxyapi
# Follow the browser prompt to complete OAuth login
```

## Usage

### Start the server

```bash
cliproxyapi
# Server runs at http://localhost:3456
```

### Test it

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### With OpenClaw

Register CLIProxyAPI as a custom provider in your `openclaw.json`:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "claude-proxy": {
        "baseUrl": "http://127.0.0.1:3456/v1",
        "apiKey": "not-needed",
        "api": "openai-completions",
        "models": [
          {
            "id": "claude-opus-4-6",
            "name": "Claude Opus 4.6",
            "contextWindow": 200000,
            "maxTokens": 16384
          },
          {
            "id": "claude-sonnet-4-6",
            "name": "Claude Sonnet 4.6",
            "contextWindow": 200000,
            "maxTokens": 16384
          },
          {
            "id": "claude-haiku-4-5-20251001",
            "name": "Claude Haiku 4.5",
            "contextWindow": 200000,
            "maxTokens": 16384
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "claude-proxy/claude-sonnet-4-6"
      }
    }
  }
}
```

Key points:

- **`baseUrl`**: Points to your local CLIProxyAPI instance
- **`apiKey`**: Set to any non-empty string; OAuth is handled by the proxy
- **`api`**: Must be `"openai-completions"` since the proxy speaks the OpenAI protocol
- **Model reference**: Use `"claude-proxy/<model-id>"` format (e.g. `"claude-proxy/claude-sonnet-4-6"`)

## Available Models

| Model ID | Maps To |
| --- | --- |
| `claude-opus-4-6` | Claude Opus 4.6 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |

## Proxy and Network Configuration

When running OpenClaw Gateway alongside CLIProxyAPI on the same machine, configure your network environment carefully:

```bash
# External traffic (Telegram API, etc.) goes through your system proxy
export http_proxy="http://127.0.0.1:6152"
export https_proxy="http://127.0.0.1:6152"

# Local traffic to CLIProxyAPI must bypass the proxy
export NO_PROXY="127.0.0.1,localhost"
```

This ensures:
- The gateway reaches CLIProxyAPI via direct TCP (no proxy hop)
- External API calls (Telegram, webhooks) still route through your system proxy

> **Tip**: When testing locally with `curl`, add `--noproxy '*'` to bypass system proxy settings.

## Auto-Start on macOS

Create a LaunchAgent to run CLIProxyAPI automatically:

```bash
cat > ~/Library/LaunchAgents/ai.openclaw.proxy.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.openclaw.proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/opt/cliproxyapi/bin/cliproxyapi</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/cliproxyapi.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/cliproxyapi.stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.proxy.plist
```

## Auto-Start on Linux (systemd)

```ini
[Unit]
Description=CLIProxyAPI - Claude OAuth Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=openclaw
Group=openclaw
ExecStart=/usr/local/bin/cliproxyapi
Restart=always
RestartSec=5
ReadWritePaths=%h/.cli-proxy-api/

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now cliproxyapi
```

## Links

- **GitHub:** [https://github.com/AidenYuanDev/CLIProxyAPI](https://github.com/AidenYuanDev/CLIProxyAPI)
- **Homebrew:** `brew install cliproxyapi`

## Notes

- This is a **community tool**, not officially supported by Anthropic or OpenClaw
- Requires an active Claude Max/Pro subscription
- OAuth tokens are managed by the Claude CLI (`~/.config/claude/`); run `cliproxyapi` to re-authenticate if tokens expire
- The proxy runs locally and does not send data to any third-party servers
- Streaming responses are fully supported

## See Also

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Node.js alternative that wraps Claude Code CLI
- [Anthropic provider](/providers/anthropic) - Native OpenClaw integration with API keys
- [OpenAI provider](/providers/openai) - For OpenAI-compatible endpoints
