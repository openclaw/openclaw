---
summary: "Third-party tunnel tools for exposing the Gateway without SSH or Tailscale"
read_when:
  - You want to access the Gateway from outside your network without SSH
  - Tailscale is not an option
  - You need a quick public URL for testing or demos
title: "Tunnel Tools"
---

# Tunnel tools (alternatives to SSH)

When SSH tunnels or Tailscale are not available — for example on a restricted
network, a mobile hotspot, or when you need a quick shareable URL — third-party
tunnel tools can expose the Gateway WebSocket to the internet.

## How it works

The Gateway binds to loopback (`:18789`). A tunnel tool forwards that port
through an outbound connection to a public relay, giving you a URL like
`https://abc123.relay.example`.

```
Internet → Relay → Tunnel → localhost:18789 (Gateway WS)
```

## Recommendations

| Tool | Transport | Self-hostable | Notes |
|------|-----------|---------------|-------|
| [tunelo](https://github.com/jiweiyuan/tunelo) | QUIC | Yes | Single binary (Rust). `tunelo http 18789`. Also serves files with built-in web explorer. |
| [bore](https://github.com/ekzhang/bore) | TCP | Yes | Minimal, Rust. `bore local 18789 --to bore.pub`. Routes by port, no TLS. |
| [ngrok](https://ngrok.com) | HTTP/2 | No | Requires account. `ngrok http 18789`. Free tier has session limits. |
| [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) | HTTP/2 | No | `cloudflared tunnel --url http://localhost:18789`. Requires Cloudflare account. |
| [frp](https://github.com/fatedier/frp) | TCP/QUIC/KCP | Yes | Full-featured, config file based. Good for permanent setups. |
| [rathole](https://github.com/rapiz1/rathole) | TCP/TLS | Yes | Similar to frp but lighter. Rust, hot reload. |

## Quick setup examples

### tunelo (recommended for quick access)

```bash
# Install
curl -fsSL https://tunelo.net/install.sh | sh

# Expose the Gateway
tunelo http 18789

# Output:
#   ✔ Tunnel is ready!
#   Public URL: https://abc123.tunelo.net

# Connect from another machine
openclaw gateway status --url wss://abc123.tunelo.net --token YOUR_TOKEN
```

tunelo can also share workspace files for review:

```bash
tunelo serve ~/openclaw-workspace
# → public URL with file browser (code, PDF, video preview)
```

### bore

```bash
bore local 18789 --to bore.pub
# Gives you bore.pub:PORT
```

### ngrok

```bash
ngrok http 18789
# Gives you https://xxxx.ngrok-free.app
```

## Security considerations

- **Always set `gateway.auth.token` or `gateway.auth.password`** before
  exposing the Gateway through any tunnel. Without auth, anyone with the URL
  has full agent access.
- Prefer tools that provide TLS (tunelo, ngrok, Cloudflare Tunnel) over
  plain TCP (bore, raw frp).
- Tunnel URLs are temporary — they change on reconnect. For persistent access,
  use Tailscale or a proper VPN.
- Treat tunnel access the same as any non-loopback bind: full operator
  privileges. See [Security](/gateway/security).
