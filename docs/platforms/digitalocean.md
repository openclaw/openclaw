---
summary: "OpenClaw on DigitalOcean (simple paid VPS option)"
read_when:
  - Setting up OpenClaw on DigitalOcean
  - Looking for cheap VPS hosting for OpenClaw
title: "DigitalOcean"
---

# OpenClaw on DigitalOcean

## Goal

Run a persistent OpenClaw Gateway on DigitalOcean for **$6/month** (or $4/mo with reserved pricing).
DigitalOcean offers three deployment options: manual Droplet setup, 1-Click Marketplace app, or App Platform. Each has different tradeoffs for control, security, and scalability.

## Cost Comparison (2026)

| Provider     | Plan            | Specs                  | Price/mo    | Notes                                 |
| ------------ | --------------- | ---------------------- | ----------- | ------------------------------------- |
| Oracle Cloud | Always Free ARM | up to 4 OCPU, 24GB RAM | $0          | ARM, limited capacity / signup quirks |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM        | €3.79 (~$4) | Cheapest paid option                  |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM        | $6          | Easy UI, good docs                    |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM        | $6          | Many locations                        |
| Linode       | Nanode          | 1 vCPU, 1GB RAM        | $5          | Now part of Akamai                    |

**Picking a provider:**

- DigitalOcean: simplest UX + predictable setup (this guide)
- Hetzner: good price/perf (see [Hetzner guide](/install/hetzner))
- Oracle Cloud: can be $0/month, but is more finicky and ARM-only (see [Oracle guide](/platforms/oracle))

---

## Deployment Options

**Which option to choose:**

- **Manual Droplet (Option 1):** Full control, manual security setup. Best for custom configurations.
- **1-Click Marketplace (Option 2):** Pre-configured with enhanced security (authenticated gateway, hardened firewall, Docker isolation, non-root user). Best for fast, secure setup with minimal decisions.
- **App Platform (Option 3):** Managed infrastructure with auto-scaling, zero-downtime deploys, automatic restarts. Best for production teams needing operational maturity.

The 1-Click and App Platform deployments include additional security hardening out-of-the-box.

---

## Option 1: Manual Droplet Setup

### Prerequisites

- DigitalOcean account ([signup with $200 free credit](https://m.do.co/c/signup))
- SSH key pair (or willingness to use password auth)
- ~20 minutes

### 1) Create a Droplet

1. Log into [DigitalOcean](https://cloud.digitalocean.com/)
2. Click **Create → Droplets**
3. Choose:
   - **Region:** Closest to you (or your users)
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/mo** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication:** SSH key (recommended) or password
4. Click **Create Droplet**
5. Note the IP address

### 2) Connect via SSH

```bash
ssh root@YOUR_DROPLET_IP
```

### 3) Install OpenClaw

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

### 4) Run Onboarding

```bash
openclaw onboard --install-daemon
```

The wizard will walk you through:

- Model auth (API keys or OAuth)
- Channel setup (Telegram, WhatsApp, Discord, etc.)
- Gateway token (auto-generated)
- Daemon installation (systemd)

### 5) Verify the Gateway

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

### 6) Access the Dashboard

The gateway binds to loopback by default. To access the Control UI:

**Option A: SSH Tunnel (recommended)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**Option B: Tailscale Serve (HTTPS, loopback-only)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Open: `https://<magicdns>/`

Notes:

- Serve keeps the Gateway loopback-only and authenticates via Tailscale identity headers.
- To require token/password instead, set `gateway.auth.allowTailscale: false` or use `gateway.auth.mode: "password"`.

**Option C: Tailnet bind (no Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Open: `http://<tailscale-ip>:18789` (token required).

### 7) Connect Your Channels

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

See [Channels](/channels) for other providers.

### Optimizations for 1GB RAM

The $6 droplet only has 1GB RAM. To keep things running smoothly:

#### Add swap (recommended)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

#### Use a lighter model

If you're hitting OOMs, consider:

- Using API-based models (Claude, GPT) instead of local models
- Setting `agents.defaults.model.primary` to a smaller model

#### Monitor memory

```bash
free -h
htop
```

### Persistence

All state lives in:

- `~/.openclaw/` — config, credentials, session data
- `~/.openclaw/workspace/` — workspace (SOUL.md, memory, etc.)

These survive reboots. Back them up periodically:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Option 2: 1-Click Marketplace App

The 1-Click app includes OpenClaw pre-installed with enhanced security features:

- **Authenticated gateway token:** Prevents unauthorized access
- **Hardened firewall rules:** Rate-limits gateway ports
- **Docker container isolation:** Sandboxed execution environment
- **Non-root user execution:** Limited attack surface
- **DM pairing enabled:** Private communication by default

### 1) Create the Droplet

1. Log into [DigitalOcean](https://cloud.digitalocean.com/)
2. Click **Create → Droplets**
3. Under **Choose an Image**, select the **Marketplace** tab
4. Search for `OpenClaw` and select it
5. Choose plan: **Basic → $24/mo** (2 vCPU, 4GB RAM, 80GB SSD)
6. Add SSH key under **Authentication**
7. Click **Create Droplet**

### 2) SSH and Complete Setup

```bash
ssh root@YOUR_DROPLET_IP
```

Follow the onboarding wizard:

1. Select AI provider (Anthropic, Gradient, etc.)
2. Enter API key
3. Choose to run pairing automation (for web UI access)
4. Note the Dashboard URL displayed in the welcome message

### 3) Access the UI

The onboarding provides a gateway-token-authenticated URL. Open it in your browser to access the Control UI. Or use the Text UI:

```bash
/opt/openclaw-tui.sh
```

### 4) Install Skills

From the web UI:

1. Navigate to **Skills** section
2. Search for desired skill (e.g., "calendar")
3. Click **Install**

---

## Option 3: App Platform

App Platform provides managed infrastructure with automatic scaling, zero-downtime deploys, and operational consistency. Best for teams and production deployments.

### 1) Deploy from GitHub

1. Go to the [OpenClaw App Platform repo](https://github.com/digitalocean-labs/openclaw-appplatform)
2. Click **Deploy to DigitalOcean** button
3. Sign in to your DigitalOcean account
4. Under **Environment Variables**, click **Edit**
5. Add your model API key (e.g., `GRADIENT_API_KEY`)
6. Click **Create App**

The build takes ~5 minutes.

### 2) Connect Channels

Once built, go to the **Console** tab:

Switch to the `openclaw` user and navigate to the home directory:

```bash
su openclaw
cd
```

Connect WhatsApp (or other channels):

```bash
openclaw channels login --channel whatsapp
# Scan QR code
```

### 3) Install Skills

```bash
# Browse available skills
openclaw skills

# Install a skill
npx clawhub install <skill_name>
```

### Remote Access

To connect remotely, [install doctl](https://docs.digitalocean.com/reference/doctl/how-to/install/) and use:

```bash
doctl apps console <APP_ID>
```

Alternatively, use the Console tab in the DigitalOcean control panel.

---

## Troubleshooting

### Gateway won't start

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### Port already in use

```bash
lsof -i :18789
kill <PID>
```

### Out of memory

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## See Also

- [Hetzner guide](/install/hetzner) — cheaper, more powerful
- [Docker install](/install/docker) — containerized setup
- [Tailscale](/gateway/tailscale) — secure remote access
- [Configuration](/gateway/configuration) — full config reference
