---
summary: "Run OpenClaw Gateway on Linode (Akamai Connected Cloud) — low-latency global VPS"
read_when:
  - Setting up OpenClaw on Linode or Akamai Connected Cloud
  - Looking for low-latency VPS hosting for OpenClaw
title: "Linode (Akamai Connected Cloud)"
---

# OpenClaw on Linode (Akamai Connected Cloud)

## Goal

Run a persistent OpenClaw Gateway on [Akamai Connected Cloud (Linode)](https://www.linode.com/) for **$5/month** with low-latency access from anywhere in the world.

## Why Linode

Linode is part of Akamai Connected Cloud, giving you access to **30+ global data centers** spanning North America, Europe, Asia-Pacific, South America, and Africa. This means you can deploy your Gateway close to wherever you or your users are, minimizing latency for real-time messaging channels like WhatsApp, Telegram, and Discord.

- **Global reach** — deploy in the region closest to your users for the lowest round-trip times
- **$5/month Nanode** — 1 vCPU, 1GB RAM, 25GB SSD, enough to run the Gateway 24/7
- **Free Cloud Firewall** — network-level filtering before traffic reaches your instance
- **Simple scaling** — resize to a larger plan from the Cloud Manager with no re-provisioning
- **Automated backups** — optional $2/month add-on for worry-free snapshots

---

## Prerequisites

- Linode account ([sign up at cloud.linode.com](https://cloud.linode.com/))
- SSH key pair (or willingness to use password auth)
- ~20 minutes

## 1) Create a Linode

<Warning>
Use a clean base image (Ubuntu 24.04 LTS). Avoid StackScripts or Marketplace images unless you have reviewed their startup scripts and firewall defaults.
</Warning>

1. Log into [Akamai Cloud Manager](https://cloud.linode.com/)
2. Click **Create → Linode**
3. Choose:
   - **Region:** Closest to you or your users — Linode has data centers in Newark, Dallas, Fremont, Toronto, London, Frankfurt, Mumbai, Singapore, Tokyo, Sydney, Sao Paulo, and many more
   - **Image:** Ubuntu 24.04 LTS
   - **Plan:** Shared CPU → **Nanode 1GB** ($5/mo — 1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication:** SSH key (recommended) or root password
4. Click **Create Linode**
5. Note the IP address once it's running

## 2) Connect via SSH

```bash
ssh root@YOUR_LINODE_IP
```

## 3) Install OpenClaw

```bash
# Update system
apt update && apt upgrade -y

# Install OpenClaw (installs Node.js automatically if needed)
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4) Run Onboarding

```bash
openclaw onboard --install-daemon
```

The wizard will walk you through:

- Model auth (API keys or OAuth)
- Channel setup (Telegram, WhatsApp, Discord, etc.)
- Gateway token (auto-generated)
- Daemon installation (systemd)

## 5) Verify the Gateway

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6) Access the Dashboard

The gateway binds to loopback by default. To access the Control UI:

**Option A: SSH Tunnel (recommended)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_LINODE_IP

# Then open: http://localhost:18789
```

**Option B: Tailscale Serve (HTTPS, loopback-only)**

```bash
# On the Linode
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Open: `https://<magicdns>/`

Notes:

- Serve keeps the Gateway loopback-only and authenticates Control UI/WebSocket traffic via Tailscale identity headers (tokenless auth assumes trusted gateway host; HTTP APIs still require token/password).
- To require token/password instead, set `gateway.auth.allowTailscale: false` or use `gateway.auth.mode: "password"`.

**Option C: Tailnet bind (no Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Open: `http://<tailscale-ip>:18789` (token required).

## 7) Connect Your Channels

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

---

## Optimizations for 1GB RAM

The Nanode plan only has 1GB RAM. To keep things running smoothly:

### Add swap (recommended)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Use a lighter model

If you're hitting OOMs, consider:

- Using API-based models (Claude, GPT) instead of local models
- Setting `agents.defaults.model.primary` to a smaller model

### Monitor memory

```bash
free -h
htop
```

---

## Linode-specific tips

### Cloud Firewall

Linode offers a free [Cloud Firewall](https://www.linode.com/docs/products/networking/cloud-firewall/) that filters traffic before it hits your instance. Recommended rules:

- **Allow** TCP 22 (SSH) from your IP
- **Drop** everything else inbound

Since the Gateway binds to loopback by default, no additional port rules are needed unless you choose to expose it publicly.

### Backups

Linode offers automated backups for $2/month on the Nanode plan. Alternatively, back up manually:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

### Resize

If you outgrow the Nanode, you can resize to a larger plan directly from the Cloud Manager without re-provisioning. The 2GB Dedicated CPU plan is a good next step for heavier workloads.

---

## Persistence

All state lives in:

- `~/.openclaw/` — config, credentials, session data
- `~/.openclaw/workspace/` — workspace (SOUL.md, memory, etc.)

These survive reboots. Back them up periodically.

---

## Troubleshooting

### Gateway will not start

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

# Add more swap or resize to a larger plan
```

---

## See Also

- [Docker install](/install/docker) — containerized setup
- [Tailscale](/gateway/tailscale) — secure remote access
- [Configuration](/gateway/configuration) — full config reference
- [Linux Server](/vps) — generic VPS tuning tips
