# Reverse Proxy Setup Guide

Complete guide for running OpenClaw behind a reverse proxy (Cloudflare Tunnel, nginx, Caddy, Traefik, etc.).

## Quick Start

### Required Configuration

When using any reverse proxy that terminates TLS:

```json
{
  "gateway": {
    "bind": "lan",
    "controlUi": {
      "allowInsecureAuth": true // ⚠️ Required for reverse proxies
    },
    "auth": {
      "mode": "token",
      "token": "your-secure-token-here"
    },
    "trustedProxies": ["127.0.0.1"] // Add your proxy's IP
  }
}
```

**Set via CLI:**

```bash
openclaw config set gateway.bind "lan"
openclaw config set gateway.controlUi.allowInsecureAuth true
openclaw config set gateway.trustedProxies '["127.0.0.1"]'
```

## Why `allowInsecureAuth: true` is Required

### The Problem

When you use a reverse proxy (Cloudflare Tunnel, nginx, Caddy):

1. **Client** → **Reverse Proxy** (HTTPS, secure)
2. **Reverse Proxy** → **OpenClaw** (HTTP, local)

OpenClaw sees the connection from the reverse proxy as "insecure" (HTTP, not HTTPS) and rejects authentication by default.

### The Solution

Setting `allowInsecureAuth: true` tells OpenClaw to accept authentication over HTTP when:

- Behind a trusted reverse proxy
- The reverse proxy handles TLS termination
- The connection between proxy and OpenClaw is local/trusted

### Security Considerations

**This is safe when:**

- ✅ Reverse proxy terminates TLS (client connections are encrypted)
- ✅ OpenClaw binds to localhost or LAN only
- ✅ Firewall blocks direct access to OpenClaw port
- ✅ Reverse proxy is on the same machine or trusted network

**Don't use this when:**

- ❌ Exposing OpenClaw directly to the internet without a reverse proxy
- ❌ Reverse proxy is on an untrusted network
- ❌ No firewall protection

## Common Reverse Proxies

### Cloudflare Tunnel

**Popular for Raspberry Pi and home servers - no port forwarding needed!**

#### Setup

1. **Install cloudflared:**

   ```bash
   # Raspberry Pi (ARM64)
   wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
   sudo mv cloudflared-linux-arm64 /usr/local/bin/cloudflared
   sudo chmod +x /usr/local/bin/cloudflared
   ```

2. **Authenticate:**

   ```bash
   cloudflared tunnel login
   ```

3. **Create tunnel:**

   ```bash
   cloudflared tunnel create openclaw
   # Note the tunnel ID from output
   ```

4. **Configure tunnel** (`~/.cloudflared/config.yml`):

   ```yaml
   tunnel: <your-tunnel-id>
   credentials-file: /home/admin/.cloudflared/<your-tunnel-id>.json

   ingress:
     - hostname: openclaw.yourdomain.com
       service: http://localhost:3030
     - service: http_status:404
   ```

5. **Configure OpenClaw:**

   ```bash
   openclaw config set gateway.bind "lan"
   openclaw config set gateway.controlUi.allowInsecureAuth true
   openclaw config set gateway.trustedProxies '["127.0.0.1"]'
   ```

6. **Start tunnel:**

   ```bash
   cloudflared tunnel run openclaw
   ```

7. **Create DNS record:**

   ```bash
   cloudflared tunnel route dns openclaw openclaw.yourdomain.com
   ```

**Access:** <https://openclaw.yourdomain.com>

---

### nginx

#### Configuration

**`/etc/nginx/sites-available/openclaw`:**

```nginx
server {
    listen 80;
    server_name openclaw.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name openclaw.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3030;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

**OpenClaw config:**

```bash
openclaw config set gateway.bind "127.0.0.1"
openclaw config set gateway.controlUi.allowInsecureAuth true
openclaw config set gateway.trustedProxies '["127.0.0.1"]'
```

**Enable and restart:**

```bash
sudo ln -s /etc/nginx/sites-available/openclaw /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

---

### Caddy

**Automatic HTTPS with Let's Encrypt!**

#### Caddy Configuration

**`/etc/caddy/Caddyfile`:**

```caddy
openclaw.yourdomain.com {
    reverse_proxy localhost:3030 {
        header_up Host {host}
        header_up X-Real-IP {remote}
        header_up X-Forwarded-For {remote}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

**OpenClaw config:**

```bash
openclaw config set gateway.bind "127.0.0.1"
openclaw config set gateway.controlUi.allowInsecureAuth true
openclaw config set gateway.trustedProxies '["127.0.0.1"]'
```

**Reload Caddy:**

```bash
sudo systemctl reload caddy
```

Caddy automatically obtains and renews SSL certificates from Let's Encrypt.

---

### Traefik

#### Docker Compose Example

**`docker-compose.yml`:**

```yaml
version: "3.8"

services:
  openclaw:
    image: openclaw/openclaw:latest
    volumes:
      - ./openclaw-data:/home/node/.openclaw
    environment:
      - OPENCLAW_GATEWAY_BIND=0.0.0.0
      - OPENCLAW_GATEWAY_CONTROL_UI_ALLOW_INSECURE_AUTH=true
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.openclaw.rule=Host(`openclaw.yourdomain.com`)"
      - "traefik.http.routers.openclaw.entrypoints=websecure"
      - "traefik.http.routers.openclaw.tls.certresolver=letsencrypt"
      - "traefik.http.services.openclaw.loadbalancer.server.port=3030"

  traefik:
    image: traefik:v2.10
    command:
      - "--api.insecure=true"
      - "--providers.docker=true"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.letsencrypt.acme.email=you@example.com"
      - "--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
      - "--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - "/var/run/docker.sock:/var/run/docker.sock:ro"
      - "./letsencrypt:/letsencrypt"
```

---

## Troubleshooting

### Dashboard Returns Error 1008

**Symptoms:**

- Can't access dashboard
- Error: "Device token mismatch" (1008)
- Worked before config change

**Cause:** `allowInsecureAuth` not set while using reverse proxy

**Fix:**

```bash
openclaw config set gateway.controlUi.allowInsecureAuth true
systemctl --user restart openclaw-gateway.service
```

### Connection Refused

**Check OpenClaw is running:**

```bash
systemctl --user status openclaw-gateway.service
```

**Check bind address:**

```bash
openclaw config get gateway.bind
# Should be "lan" or "0.0.0.0" for reverse proxy access
```

**Test local access:**

```bash
curl http://localhost:3030
# Should return OpenClaw dashboard HTML
```

### WebSocket Connection Fails

**nginx:** Add WebSocket headers (see config above)

**Caddy:** Works by default

**Cloudflare Tunnel:** Works by default

**Check logs:**

```bash
journalctl --user -u openclaw-gateway -f | grep -i websocket
```

### IP Address Shows as Proxy IP

**Set trustedProxies:**

```bash
openclaw config set gateway.trustedProxies '["127.0.0.1", "::1"]'
```

This tells OpenClaw to trust the X-Forwarded-For header from your reverse proxy.

## Security Best Practices

### 1. Firewall Rules

Block direct access to OpenClaw port:

```bash
# UFW (Ubuntu/Debian)
sudo ufw deny 3030
sudo ufw allow 80
sudo ufw allow 443

# iptables
sudo iptables -A INPUT -p tcp --dport 3030 -j DROP
sudo iptables -A INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 443 -j ACCEPT
```

### 2. Strong Authentication

Use a strong gateway token:

```bash
# Generate secure token
TOKEN=$(openssl rand -base64 32)
openclaw config set gateway.auth.token "$TOKEN"
echo "Your token: $TOKEN"  # Save this securely
```

### 3. Rate Limiting

**nginx:**

```nginx
limit_req_zone $binary_remote_addr zone=openclaw:10m rate=10r/s;

server {
    location / {
        limit_req zone=openclaw burst=20;
        # ... proxy settings
    }
}
```

**Caddy:**

```caddy
openclaw.yourdomain.com {
    rate_limit {
        zone openclaw {
            key {remote_host}
            events 10
            window 1s
        }
    }
    reverse_proxy localhost:3030
}
```

### 4. IP Allowlist (Optional)

**Cloudflare:** Use Access policies

**nginx:**

```nginx
location / {
    allow 1.2.3.4;      # Your IP
    deny all;
    # ... proxy settings
}
```

## Validation Script

Run the reverse proxy validator:

```bash
./scripts/doctor/check-reverse-proxy.sh
```

Checks:

- `allowInsecureAuth` configuration
- `trustedProxies` settings
- Firewall rules
- TLS certificate validity
- WebSocket support

## See Also

- [Gateway Configuration](./configuration.md)
- [Security Guide](../security/README.md)
- [Troubleshooting Dashboard Auth](../troubleshooting/config-errors.md#dashboard-authentication-fails-error-1008)
- [GitHub Issue #20524](https://github.com/openclaw/openclaw/issues/20524)
