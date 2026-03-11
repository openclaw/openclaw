---
name: auth-tunnel
description: |
  Secure web authentication for headless servers. Opens a login page via reverse proxy + Tailscale Funnel so the user can log in on their phone/laptop. Captures session cookies/tokens after login. Use when the user needs to authenticate with a web service (JeFIT, Amazon, etc.) and you need the resulting session tokens.
---

# Auth Tunnel Skill

Authenticate with web services on a headless server by proxying the login page through Tailscale Funnel. The user logs in on their phone with full native HTML (keyboard, responsive layout) — credentials go directly to the target service over HTTPS, never through chat.

## Prerequisites

- **Node.js 18+**
- **Tailscale** with Funnel enabled
- Operator set for non-root usage: `sudo tailscale set --operator=$USER`

## Files

- `auth-proxy.cjs` — Reverse proxy server with cookie capture
- `auth-tunnel.sh` — Legacy VNC-based approach (fallback only)
- `extract-cookies.cjs` — CDP cookie extraction (used by VNC approach)

## Workflow

### 1. Start the proxy

```bash
nohup node <skill-dir>/auth-proxy.cjs "<login-url>" \
  --port 7890 \
  --extract-cookies "<domain>" \
  --output /tmp/<service>-cookies.json > /tmp/auth-proxy.log 2>&1 &
disown
```

### 2. Start Tailscale Funnel

```bash
tailscale funnel --https=8443 --bg http://localhost:7890
```

### 3. Get the funnel URL

```bash
HOSTNAME=$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')
echo "https://${HOSTNAME}:8443/"
```

### 4. Send the URL to the user

Send the URL via chat. The user opens it, sees the native login page, and logs in.

### 5. After login — extract cookies

Check status:
```bash
curl -s http://127.0.0.1:7890/__auth_proxy__/cookies | jq 'length'
```

Save cookies (also shuts down proxy):
```bash
curl -s http://127.0.0.1:7890/__auth_proxy__/done
```

Or the user can visit `/__auth_proxy__/status` in their browser and click "Done".

### 6. Tear down funnel

```bash
tailscale funnel --https=8443 off
```

### 7. Use the cookies

Read the output file to get tokens/cookies for configuring plugins:
```bash
cat /tmp/<service>-cookies.json | jq '.[] | select(.name=="<token-name>") | .value'
```

## Proxy Endpoints

| Path | Description |
|------|-------------|
| `/` | Proxied target page (native HTML) |
| `/__auth_proxy__/status` | Cookie count + "Done" button (mobile-friendly) |
| `/__auth_proxy__/cookies` | Raw JSON cookie dump |
| `/__auth_proxy__/done` | Save cookies to file and shut down |

## Common Services

### JeFIT
```bash
node auth-proxy.cjs "https://www.jefit.com/login" --extract-cookies "jefit.com" --output /tmp/jefit-cookies.json
# After login, extract: jefitAccessToken, jefitRefreshToken
```

### Amazon
```bash
node auth-proxy.cjs "https://www.amazon.co.uk/ap/signin" --extract-cookies "amazon.co.uk" --output /tmp/amazon-cookies.json
```

## Security

- Credentials are typed directly into the target service's login form, served as native HTML through the proxy.
- The proxy runs on the user's own server — same trust model as a local browser.
- Tailscale Funnel provides HTTPS with valid certificates.
- Always tear down the funnel after use (`tailscale funnel --https=8443 off`).
- Cookie output files contain sensitive tokens — handle accordingly.

## Fallback: VNC Approach

If the reverse proxy doesn't work for a particular site (heavy JS SPA, anti-bot detection, etc.), use the VNC approach:

```bash
bash <skill-dir>/auth-tunnel.sh "<login-url>" --extract-cookies "<domain>" --output /tmp/cookies.json
```

Requires: Xvfb, chromium-browser, x11vnc, noVNC, websockify, jq. Poor mobile UX — use only as fallback.
