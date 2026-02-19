---
summary: "Configure OpenClaw with Cloudflare Zero Trust (Cloudflare Access + Tunnel)"
read_when:
  - Using Cloudflare Zero Trust with OpenClaw
  - Setting up Cloudflare Access policies
  - Exposing OpenClaw dashboard securely
title: "Cloudflare Zero Trust Integration"
---

# Cloudflare Zero Trust Integration

Cloudflare Zero Trust provides secure remote access to OpenClaw without exposing ports directly to the internet. This guide covers setup with **Cloudflare Tunnel** (cloudflared) and **Cloudflare Access** for identity-based authentication.

## Overview

**What is Cloudflare Zero Trust?**

Cloudflare Zero Trust replaces traditional VPNs with:

- **Cloudflare Tunnel** (cloudflared) - Secure outbound-only tunnel, no open ports
- **Cloudflare Access** - Identity-based authentication (OAuth, SAML, OTP)
- **WARP Client** - Zero Trust network access for devices
- **Gateway** - DNS filtering and network policies

**Architecture:**

```
User → Cloudflare Edge → Cloudflare Access (Auth) → Cloudflare Tunnel → OpenClaw Gateway
```

**Benefits:**

- ✅ No open firewall ports or port forwarding
- ✅ Identity-based access control (email, groups, devices)
- ✅ Automatic TLS with Cloudflare certificates
- ✅ DDoS protection and WAF included
- ✅ Works from anywhere (no VPN client needed)

## Prerequisites

1. **Cloudflare account** with domain (free tier works)
2. **Cloudflare Zero Trust plan** (free tier: 50 users)
3. **OpenClaw** installed and configured
4. **cloudflared** tunnel client

## Quick Start

### Step 1: Install cloudflared

**Linux (Raspberry Pi / Ubuntu / Debian):**

```bash
# Download for ARM64 (Raspberry Pi)
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64

# Or for x86_64 (most servers)
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64

# Install
sudo mv cloudflared-linux-* /usr/local/bin/cloudflared
sudo chmod +x /usr/local/bin/cloudflared

# Verify
cloudflared --version
```

**macOS:**

```bash
brew install cloudflared
```

**Windows:**

Download from <https://github.com/cloudflare/cloudflared/releases>

### Step 2: Authenticate Cloudflare

```bash
cloudflared tunnel login
```

This opens a browser to authorize cloudflared. Select your domain.

### Step 3: Create Tunnel

```bash
cloudflared tunnel create openclaw
```

Save the tunnel ID from output (looks like `12345678-1234-1234-1234-123456789abc`).

### Step 4: Configure Tunnel

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: 12345678-1234-1234-1234-123456789abc
credentials-file: /home/admin/.cloudflared/12345678-1234-1234-1234-123456789abc.json

ingress:
  - hostname: openclaw.yourdomain.com
    service: http://localhost:3030
  - service: http_status:404
```

**Important**: Replace:

- `12345678-1234-1234-1234-123456789abc` with your tunnel ID
- `openclaw.yourdomain.com` with your actual subdomain
- `/home/admin` with your actual home directory path

### Step 5: Configure OpenClaw

OpenClaw needs to accept requests from Cloudflare Tunnel:

```bash
openclaw config set gateway.bind "lan"
openclaw config set gateway.controlUi.allowInsecureAuth true
openclaw config set gateway.trustedProxies '["127.0.0.1", "::1"]'
```

**Why `allowInsecureAuth: true`?**

Cloudflare Tunnel terminates TLS at the edge, so requests to OpenClaw appear as HTTP from localhost. This is safe because:

- End-user connection is HTTPS to Cloudflare
- Tunnel connection is encrypted
- OpenClaw only accepts from localhost

See: [Reverse Proxy Guide](/gateway/reverse-proxy)

### Step 6: Create DNS Record

```bash
cloudflared tunnel route dns openclaw openclaw.yourdomain.com
```

This creates a CNAME record pointing to your tunnel.

### Step 7: Run Tunnel

**Test run:**

```bash
cloudflared tunnel run openclaw
```

**Install as service (systemd):**

```bash
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

**Check status:**

```bash
sudo systemctl status cloudflared
```

### Step 8: Configure Cloudflare Access

**Go to Cloudflare Zero Trust Dashboard:**

1. Navigate to <https://one.dash.cloudflare.com/>
2. Go to **Access** → **Applications**
3. Click **Add an application** → **Self-hosted**

**Application configuration:**

- **Application name**: OpenClaw Dashboard
- **Session duration**: 24 hours (or your preference)
- **Application domain**: `openclaw.yourdomain.com`
- **Identity providers**: Choose your auth method (see below)

**Policy configuration:**

Click **Next** → **Add a policy**:

- **Policy name**: Allow authorized users
- **Action**: Allow
- **Session duration**: 24 hours

**Add rules** (choose one):

- **Emails**: `you@example.com` (specific email)
- **Email domain**: `@yourcompany.com` (entire domain)
- **Everyone**: Allow all (not recommended)

Click **Next** → **Add application**

## Access Methods

### Option 1: Email OTP (Simplest)

**Setup:**

1. Cloudflare Zero Trust → **Settings** → **Authentication**
2. Click **Add new** under Login methods
3. Select **One-time PIN**
4. Save

**User experience:**

1. Visit `https://openclaw.yourdomain.com`
2. Enter email address
3. Check email for 6-digit code
4. Enter code → access granted

**Pros**: No OAuth setup, works with any email
**Cons**: Requires email each session

### Option 2: Google OAuth (Best for personal use)

**Setup:**

1. Cloudflare Zero Trust → **Settings** → **Authentication**
2. Click **Add new** → **Google**
3. Enter Client ID and Secret (from Google Cloud Console)
4. Save

**User experience:**

1. Visit `https://openclaw.yourdomain.com`
2. Click "Sign in with Google"
3. Authorize → access granted

**Pros**: Single sign-on, no codes
**Cons**: Requires Google account

### Option 3: GitHub OAuth (Best for developers)

Same as Google, but choose **GitHub** as provider.

### Option 4: Azure AD / Okta / SAML (Enterprise)

For organizations with existing SSO.

## Security Configuration

### Restrict by Email Domain

Allow only users from your organization:

**Access Policy:**

- **Selector**: Email domain
- **Value**: `yourcompany.com`
- **Action**: Allow

### Require Device Enrollment

Force users to use WARP client with device posture checks:

**Access Policy:**

- **Selector**: WARP
- **Value**: Connected
- **Action**: Allow

**Additional rules:**

- **OS Version**: Require up-to-date OS
- **Firewall**: Require enabled firewall
- **Disk Encryption**: Require encrypted disk

### IP Allowlist

Restrict to specific locations:

**Access Policy:**

- **Selector**: IP ranges
- **Value**: `203.0.113.0/24` (your office IP)
- **Action**: Allow

### Block Countries

Block traffic from specific countries:

**Gateway Policy:**

1. Go to **Gateway** → **Firewall Policies**
2. Create rule: Block if source country = `<country-code>`

## Cloudflare Access + OpenClaw Auth

You have two layers of authentication:

**Layer 1: Cloudflare Access** (Edge)

- Validates user identity (OAuth, email, etc.)
- Enforces access policies
- Happens before traffic reaches OpenClaw

**Layer 2: OpenClaw Gateway Auth** (Application)

- Optional device token authentication
- Can be bypassed for Cloudflare-authenticated requests

**Recommended config:**

```json
{
  "gateway": {
    "bind": "lan",
    "auth": {
      "mode": "token",
      "token": "your-secure-token",
      "allowInsecureAuth": true
    },
    "trustedProxies": ["127.0.0.1"],
    "controlUi": {
      "allowInsecureAuth": true
    }
  }
}
```

This keeps gateway token auth as a second layer of defense.

## Multiple Tunnels (Development + Production)

Run separate tunnels for different environments:

**Dev tunnel:**

```yaml
# ~/.cloudflared/dev-config.yml
tunnel: <dev-tunnel-id>
credentials-file: /home/admin/.cloudflared/<dev-tunnel-id>.json

ingress:
  - hostname: openclaw-dev.yourdomain.com
    service: http://localhost:3030
  - service: http_status:404
```

**Prod tunnel:**

```yaml
# ~/.cloudflared/prod-config.yml
tunnel: <prod-tunnel-id>
credentials-file: /home/admin/.cloudflared/<prod-tunnel-id>.json

ingress:
  - hostname: openclaw.yourdomain.com
    service: http://localhost:3030
  - service: http_status:404
```

**Run specific tunnel:**

```bash
cloudflared tunnel --config ~/.cloudflared/dev-config.yml run dev-openclaw
```

## Troubleshooting

### Dashboard returns 502 Bad Gateway

**Symptom:** Cloudflare Access page loads, but after auth → 502 error

**Cause:** OpenClaw not reachable from tunnel

**Check:**

```bash
# Verify OpenClaw is running
systemctl --user status openclaw-gateway.service

# Verify tunnel is running
sudo systemctl status cloudflared

# Test local access
curl http://localhost:3030
```

**Fix:**

```bash
# Restart OpenClaw
systemctl --user restart openclaw-gateway.service

# Restart tunnel
sudo systemctl restart cloudflared
```

### "Device token mismatch" (Error 1008)

**Symptom:** Dashboard loads but shows authentication error

**Cause:** `allowInsecureAuth` not set

**Fix:**

```bash
openclaw config set gateway.controlUi.allowInsecureAuth true
systemctl --user restart openclaw-gateway.service
```

See: [Reverse Proxy Troubleshooting](/troubleshooting/config-errors#dashboard-authentication-fails-error-1008)

### Access denied / not authenticated

**Symptom:** Stuck on Cloudflare Access login page

**Check policy:**

1. Go to Cloudflare Zero Trust → **Access** → **Applications**
2. Click your application → **Policies**
3. Verify your email/domain is in the Allow rule
4. Check **Logs** tab for policy evaluation results

**Common issues:**

- Email typo in policy
- Identity provider not configured
- User not verified email with provider
- Session expired (increase session duration)

### Tunnel won't start

**Error:** `tunnel <id> not found`

**Check:**

```bash
# List tunnels
cloudflared tunnel list

# Verify config file
cat ~/.cloudflared/config.yml
```

**Fix:**

- Ensure tunnel ID in config matches `cloudflared tunnel list`
- Verify credentials file path is correct
- Re-run `cloudflared tunnel login` if needed

### WebSocket connection fails

**Symptom:** Dashboard loads but real-time features don't work

**Cause:** WebSocket upgrade not working through tunnel

**Fix:** Cloudflare Tunnel supports WebSockets by default, but check:

```bash
# In config.yml, ensure no-tls-verify is NOT set
# WebSockets work automatically with http:// service
```

No special configuration needed - WebSockets work out of the box with Cloudflare Tunnel.

## Performance Considerations

### Latency

**Expected latency:**

- **Without tunnel**: 10-50ms (direct LAN access)
- **With tunnel**: 50-150ms (via Cloudflare edge)

**Optimize:**

- Choose Cloudflare edge location nearest to you
- Use WARP client for lower latency (WARP Connector)
- Consider regional tunnels (US, EU, APAC)

### Bandwidth

Cloudflare Tunnel free tier:

- **Unlimited bandwidth** for most use cases
- Subject to abuse prevention (no proxying video streaming, etc.)

## Security Best Practices

### 1. Principle of Least Privilege

Only allow users who need access:

```
Policy: Allow only specific emails
Rule: Email is in [you@example.com, teammate@example.com]
```

### 2. Short Session Duration

Require frequent re-authentication:

```
Session duration: 8 hours (or 24 hours for personal use)
```

### 3. Enable MFA

Require two-factor authentication:

**Access Policy:**

- Selector: Authentication method
- Value: Require MFA
- Action: Allow

### 4. Monitor Access Logs

Check who's accessing:

1. Cloudflare Zero Trust → **Logs** → **Access**
2. Review authentication attempts
3. Set up alerts for suspicious access patterns

### 5. Use Device Posture Checks

Require managed devices only:

- Enable WARP client requirement
- Enforce OS version requirements
- Check disk encryption, firewall status

### 6. Rotate Tunnel Credentials

Regularly rotate tunnel credentials:

```bash
# Create new tunnel
cloudflared tunnel create openclaw-new

# Update config with new tunnel ID
# Delete old tunnel after migration
cloudflared tunnel delete openclaw-old
```

## Cost

**Cloudflare Zero Trust Free Tier:**

- Up to 50 users
- Unlimited applications
- Unlimited tunnel bandwidth
- Basic Access policies
- Email OTP auth included

**Paid plans:**

- **Standard**: $7/user/month (advanced policies, DLP, CASB)
- **Enterprise**: Custom pricing (SLA, dedicated support)

For personal/small team use, **free tier is sufficient**.

## Comparison with Other Solutions

| Feature              | Cloudflare Zero Trust | Tailscale | Traditional VPN |
| -------------------- | --------------------- | --------- | --------------- |
| No client required   | ✅                    | ❌        | ❌              |
| Identity-based auth  | ✅                    | ✅        | ⚠️              |
| DDoS protection      | ✅                    | ❌        | ❌              |
| Free tier            | 50 users              | 100 nodes | N/A             |
| Setup complexity     | Medium                | Low       | High            |
| Performance overhead | Low                   | Very Low  | Medium          |
| Works behind NAT     | ✅                    | ✅        | ⚠️              |

**When to use Cloudflare Zero Trust:**

- You want web-based access (no VPN client)
- You need identity-based access control
- You want DDoS protection included
- You're exposing to untrusted networks

**When to use Tailscale:**

- You already use Tailscale
- You need lowest possible latency
- You prefer peer-to-peer architecture
- You're comfortable with VPN concepts

See: [Tailscale Integration](/gateway/tailscale)

## Related Documentation

- [Reverse Proxy Setup](/gateway/reverse-proxy) - General reverse proxy configuration
- [Tailscale Integration](/gateway/tailscale) - Alternative secure access method
- [Gateway Configuration](/gateway/configuration) - Complete gateway config reference
- [Security Guide](/gateway/security) - OpenClaw security best practices

## External Resources

- Cloudflare Zero Trust: <https://www.cloudflare.com/zero-trust/>
- Cloudflare Tunnel Docs: <https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/>
- Cloudflare Access Docs: <https://developers.cloudflare.com/cloudflare-one/policies/access/>
- cloudflared GitHub: <https://github.com/cloudflare/cloudflared>

---

**Need help?** Ask in [Discord #setup-help](https://discord.gg/qkhbAGHRBT) or open a [GitHub Discussion](https://github.com/openclaw/openclaw/discussions).
