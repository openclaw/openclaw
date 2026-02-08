# Discord Gateway Proxy Configuration

This document explains how to configure OpenClaw to use a proxy for Discord Gateway connections.

## Background

The Discord Gateway uses WebSocket connections (wss://) which may require proxy configuration in certain network environments:
- Corporate firewalls
- Regions with restricted network access
- SOCKS5/HTTP proxy requirements

## Configuration Methods

### Method 1: Using Gateway Plugin Agent (Recommended)

If you're using Carbon 0.15.0+ with agent support:

```typescript
import { SocksProxyAgent } from 'socks-proxy-agent'

const agent = new SocksProxyAgent('socks5://127.0.0.1:7898')

const client = new Client(
    { token: process.env.DISCORD_BOT_TOKEN },
    { commands: [] },
    [
        new GatewayPlugin({
            intents: GatewayIntents.GuildMessages,
            agent  // Pass the agent here
        })
    ]
)
```

### Method 2: Environment Variables (For HTTP requests)

OpenClaw respects standard proxy environment variables for HTTP requests:

```bash
export HTTP_PROXY=http://127.0.0.1:7897
export HTTPS_PROXY=http://127.0.0.1:7897
```

**Note**: These work for HTTP requests but NOT for WebSocket connections due to Node.js ws library limitations.

### Method 3: Systemd Service Override

For systemd-managed gateway, edit the service override:

```bash
mkdir -p ~/.config/systemd/user/openclaw-gateway.service.d
nano ~/.config/systemd/user/openclaw-gateway.service.d/override.conf
```

Add:
```ini
[Service]
Environment="HTTP_PROXY=http://127.0.0.1:7897"
Environment="HTTPS_PROXY=http://127.0.0.1:7897"
```

Then reload:
```bash
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway
```

## Common Proxy Configurations

### SOCKS5 (Clash, V2Ray, etc.)

```typescript
import { SocksProxyAgent } from 'socks-proxy-agent'
const agent = new SocksProxyAgent('socks5://127.0.0.1:7898')
```

### HTTP Proxy

```typescript
import { HttpsProxyAgent } from 'https-proxy-agent'
const agent = new HttpsProxyAgent('http://127.0.0.1:8080')
```

### Clash Verge

Default ports:
- HTTP Proxy: 7897
- SOCKS5 Proxy: 7898

## Troubleshooting

### Error 1006 (WebSocket Connection Closed)

This error indicates the WebSocket connection failed. Check:
1. Proxy is running and accessible
2. Proxy supports WebSocket (ws:// and wss://)
3. Firewall allows proxy connections

### Verify Proxy Connection

Test your proxy:
```bash
# Test SOCKS5
curl --socks5 127.0.0.1:7898 https://www.google.com

# Test HTTP
curl -x http://127.0.0.1:7897 https://www.google.com
```

## Related

- Carbon PR: [feat(gateway): add WebSocket agent/proxy support](https://github.com/buape/carbon/pull/352)
- [socks-proxy-agent documentation](https://www.npmjs.com/package/socks-proxy-agent)
