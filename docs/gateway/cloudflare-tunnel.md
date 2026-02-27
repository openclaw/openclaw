---
summary: "Expose the Gateway over the public internet using Cloudflare Tunnel (cloudflared)"
read_when:
  - Setting up remote access without a VPN or tailnet
  - Exposing the Gateway to the public internet securely
  - Choosing between Tailscale and Cloudflare for remote access
title: "Cloudflare Tunnel"
---

# Cloudflare Tunnel

Cloudflare Tunnel lets you expose your loopback-only Gateway to the public internet
without opening inbound ports or configuring a VPN. The `cloudflared` daemon creates
an outbound-only connection from your Gateway host to Cloudflare's network, which
then proxies traffic to your Gateway.

## When to use Cloudflare Tunnel

- You need **public internet** access to your Gateway (no VPN/tailnet required on clients).
- Your network blocks inbound connections or you cannot forward ports.
- You want Cloudflare's DDoS protection and edge TLS termination.
- You already use Cloudflare for DNS or other services.

For tailnet-only (private network) access, [Tailscale](/gateway/tailscale) is
simpler. For SSH-based access, see [Remote access](/gateway/remote).

## Prerequisites

- A Cloudflare account (free tier works).
- A domain managed by Cloudflare DNS (or use a `*.trycloudflare.com` quick tunnel for testing).
- `cloudflared` installed on the Gateway host ([install guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
- The Gateway running on loopback (default `127.0.0.1:18789`).

## Quick tunnel (testing only)

For quick testing without DNS setup, use a temporary `trycloudflare.com` subdomain:

```bash
cloudflared tunnel --url http://127.0.0.1:18789
```

This prints a URL like `https://random-words.trycloudflare.com`. The URL changes
every time you restart `cloudflared`. Do not use this for production.

## Named tunnel setup

### Step 1: Authenticate cloudflared

```bash
cloudflared tunnel login
```

This opens a browser to authorize `cloudflared` with your Cloudflare account.

### Step 2: Create a tunnel

```bash
cloudflared tunnel create openclaw-gateway
```

Note the tunnel ID printed (e.g., `a1b2c3d4-...`). A credentials file is saved
to `~/.cloudflared/<tunnel-id>.json`.

### Step 3: Configure the tunnel

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /home/user/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: openclaw.example.com
    service: http://127.0.0.1:18789
    originRequest:
      # Required for WebSocket support
      noTLSVerify: true
  - service: http_status:404
```

Replace `openclaw.example.com` with your actual domain and update the
`credentials-file` path.

### Step 4: Create a DNS record

```bash
cloudflared tunnel route dns openclaw-gateway openclaw.example.com
```

This creates a CNAME record pointing `openclaw.example.com` to your tunnel.

### Step 5: Run the tunnel

```bash
cloudflared tunnel run openclaw-gateway
```

Your Gateway is now accessible at `https://openclaw.example.com`.

## Gateway configuration

Keep the Gateway bound to loopback. Cloudflare Tunnel handles TLS and public routing.

### With token or password auth

Since the tunnel exposes your Gateway to the public internet, always configure
authentication:

```json5
{
  gateway: {
    bind: "loopback",
    auth: {
      mode: "password",
      password: "replace-with-a-strong-password",
    },
  },
}
```

Prefer `OPENCLAW_GATEWAY_PASSWORD` (environment variable) over writing the password
to disk.

### With Cloudflare Access (trusted-proxy auth)

For SSO-based authentication, add a [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
application in front of your tunnel. Cloudflare Access authenticates users and
passes identity headers to the Gateway.

```json5
{
  gateway: {
    bind: "loopback",
    trustedProxies: ["127.0.0.1"],
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "cf-access-authenticated-user-email",
        requiredHeaders: ["cf-access-jwt-assertion"],
      },
    },
  },
}
```

Since `cloudflared` runs on the same host, the proxy traffic arrives from
`127.0.0.1`. See [Trusted Proxy Auth](/gateway/trusted-proxy-auth) for the full
reference.

## Running as a service

### Linux (systemd)

Install `cloudflared` as a system service:

```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

This uses the config at `/etc/cloudflared/config.yml` (copy your config there or
symlink it).

### macOS (launchd)

```bash
sudo cloudflared service install
```

Or create a Launch Agent manually (similar to the
[SSH tunnel Launch Agent](/gateway/remote-gateway-readme#auto-start-tunnel-on-login)).

## WebSocket support

Cloudflare Tunnel supports WebSocket connections by default. The Gateway
WebSocket endpoint works through the tunnel without additional configuration.

If you experience WebSocket timeouts, check that:

- The `ingress` rule in your `cloudflared` config points to the correct Gateway port.
- Your Cloudflare zone does not have a firewall rule blocking WebSocket upgrades.
- You are connecting via `wss://` (not `ws://`) since Cloudflare terminates TLS.

## Client configuration

Once the tunnel is running, configure the CLI to use the public URL:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "wss://openclaw.example.com",
      password: "your-password",
    },
  },
}
```

Note: use `wss://` (not `ws://`) since Cloudflare provides TLS.

## Security considerations

- **Always require authentication.** A public tunnel without auth exposes your
  Gateway (and its shell access) to the internet.
- **Prefer Cloudflare Access** for production deployments. It adds SSO, device
  posture checks, and audit logging before traffic reaches your Gateway.
- **Keep the Gateway on loopback.** Never bind to `lan` or `0.0.0.0` when using
  a tunnel; let `cloudflared` be the only path in.
- **Audit regularly.** Run `openclaw security audit` to check for misconfigurations.
- **Quick tunnels are not secure for production.** The URL is public and
  unauthenticated by default.

For the full security model, see [Security](/gateway/security).

## Comparison with other remote access methods

| Method                                                                         | Network          | Auth              | Setup    | Best for                             |
| ------------------------------------------------------------------------------ | ---------------- | ----------------- | -------- | ------------------------------------ |
| [SSH tunnel](/gateway/remote)                                                  | Any (SSH access) | SSH keys          | Minimal  | Quick CLI access                     |
| [Tailscale Serve](/gateway/tailscale)                                          | Tailnet only     | Identity headers  | Easy     | Private access across devices        |
| [Tailscale Funnel](/gateway/tailscale#public-internet-funnel--shared-password) | Public internet  | Password required | Easy     | Simple public access                 |
| **Cloudflare Tunnel**                                                          | Public internet  | Password or SSO   | Moderate | Production public access with SSO    |
| [Trusted proxy](/gateway/trusted-proxy-auth)                                   | Depends on proxy | SSO/OAuth         | Advanced | Enterprise with existing proxy infra |

## Troubleshooting

### Tunnel connects but Gateway returns 401/403

Authentication is not configured correctly. Check:

- `OPENCLAW_GATEWAY_PASSWORD` is set on the Gateway host.
- The CLI client is using the correct password in `gateway.remote.password`.
- If using Cloudflare Access, verify `trustedProxies` includes `127.0.0.1`.

### WebSocket connection drops

- Check `cloudflared` logs: `journalctl -u cloudflared -f` (systemd) or
  `cloudflared tunnel run --loglevel debug openclaw-gateway`.
- Verify the Gateway is running: `openclaw health`.
- Check Cloudflare dashboard for tunnel health under **Zero Trust > Networks > Tunnels**.

### DNS not resolving

- Verify the CNAME record exists: `dig openclaw.example.com CNAME`.
- Wait a few minutes for DNS propagation after `cloudflared tunnel route dns`.
- Check that the domain is active on Cloudflare (not just registered elsewhere).

## Learn more

- Cloudflare Tunnel overview: [https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- Cloudflare Access: [https://developers.cloudflare.com/cloudflare-one/policies/access/](https://developers.cloudflare.com/cloudflare-one/policies/access/)
- `cloudflared` downloads: [https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
