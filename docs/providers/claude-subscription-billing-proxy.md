---
summary: "Route OpenClaw Anthropic requests through Claude Max/Pro subscription billing"
read_when:
  - You want to use Claude Max/Pro subscription billing with OpenClaw
  - OpenClaw returns 402 extra usage errors with valid Claude subscription
  - You want subscription-included billing for anthropic/* models
title: "Claude Subscription Billing Proxy"
---

# Claude Subscription Billing Proxy

The [openclaw-billing-proxy](https://github.com/zacdcook/openclaw-billing-proxy) routes OpenClaw Anthropic API requests through your Claude Max or Pro subscription instead of extra usage billing.

<Warning>
**Review the source before running.** The proxy is a community tool (not
officially supported by Anthropic or OpenClaw). Before running `setup.js` or
`proxy.js`, review the
[source code](https://github.com/zacdcook/openclaw-billing-proxy/blob/main/proxy.js)
(single file, zero dependencies). The proxy reads your Claude Code OAuth token
from the macOS Keychain or credential file, and all API requests (including
conversation content) pass through the proxy on localhost. No data is sent to
third-party servers.
</Warning>

## How it works

```
OpenClaw Gateway -> Billing Proxy (localhost:18801) -> Anthropic API
                    normalizes request payload
                    uses subscription OAuth token
```

The proxy normalizes the request payload so Anthropic's billing system classifies it under your subscription instead of extra usage.

## Setup

<Steps>
  <Step title="Install and configure">
    Requires Node.js 18+ and Claude Code CLI authenticated (`claude auth login`).

    ```bash
    git clone https://github.com/zacdcook/openclaw-billing-proxy
    cd openclaw-billing-proxy
    node setup.js
    ```

    The setup script detects your Claude Code credentials and generates `config.json`.

  </Step>
  <Step title="Start the proxy">
    ```bash
    node proxy.js
    ```

    Verify the proxy shows your subscription type and token expiry.

  </Step>
  <Step title="Configure OpenClaw">
    Set `models.providers.anthropic.baseUrl` to point at the proxy in `~/.openclaw/openclaw.json`:

    ```json
    {
      "models": {
        "providers": {
          "anthropic": {
            "baseUrl": "http://127.0.0.1:18801"
          }
        }
      }
    }
    ```

    Set your agent models to use `anthropic/claude-opus-4-6` or `anthropic/claude-sonnet-4-6`:

    ```json
    {
      "agents": {
        "defaults": {
          "model": {
            "primary": "anthropic/claude-opus-4-6",
            "fallbacks": ["anthropic/claude-sonnet-4-6"]
          }
        }
      }
    }
    ```

    Update per-agent model overrides in `agents.list[]` as well.

  </Step>
  <Step title="Restart and verify">
    ```bash
    openclaw gateway stop
    openclaw gateway
    ```

    Send a test message. The proxy console should show `200` responses:

    ```
    [12:00:00] #1 POST /v1/messages (83714b -> 41274b)
    [12:00:00] #1 > 200
    ```

  </Step>
</Steps>

## Token refresh

Claude Code OAuth tokens expire periodically (typically every 8-12 hours). To refresh:

1. Open any Claude Code CLI session (refreshes the keychain credential)
2. Run `node setup.js` in the proxy directory (extracts the fresh token)

The proxy picks up the new token on the next request.

## Running as a service

<AccordionGroup>
  <Accordion title="macOS (launchd)">
    ```bash
    cat > ~/Library/LaunchAgents/com.openclaw.billing-proxy.plist << 'EOF'
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
      "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
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

  </Accordion>
  <Accordion title="Linux (systemd)">
    ```bash
    mkdir -p ~/.config/systemd/user
    cat > ~/.config/systemd/user/openclaw-billing-proxy.service << 'EOF'
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

  </Accordion>
</AccordionGroup>

## Rollback

To revert to direct API access, change `baseUrl` back in `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "anthropic": {
        "baseUrl": "https://api.anthropic.com"
      }
    }
  }
}
```

Then restart the gateway.

## Troubleshooting

| Problem                   | Solution                                                                    |
| ------------------------- | --------------------------------------------------------------------------- |
| Proxy shows no requests   | Verify `baseUrl` points to `http://127.0.0.1:18801` and restart the gateway |
| 401 authentication errors | Token expired. Run `claude auth login`, then `node setup.js`                |
| 402 errors through proxy  | Run `node troubleshoot.js` in the proxy directory                           |

## Related

<CardGroup cols={2}>
  <Card title="Claude Max API Proxy" href="/providers/claude-max-api-proxy" icon="bolt">
    OpenAI-compatible proxy that wraps Claude Code CLI.
  </Card>
  <Card title="Anthropic provider" href="/providers/anthropic" icon="robot">
    Native integration with Claude CLI or API keys.
  </Card>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Overview of all providers, model refs, and failover.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference.
  </Card>
</CardGroup>
