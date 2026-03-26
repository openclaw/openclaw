---
summary: "Run OpenClaw Gateway on Linode (Akamai Connected Cloud) — low-latency global VPS"
read_when:
  - Setting up OpenClaw on Linode or Akamai Connected Cloud
  - Looking for low-latency VPS hosting for OpenClaw
title: "Linode (Akamai Connected Cloud)"
---

# OpenClaw on Linode (Akamai Connected Cloud)

Run a persistent OpenClaw Gateway on [Akamai Connected Cloud (Linode)](https://www.linode.com/) for **$5/month** with low-latency access from anywhere in the world.

Linode is part of Akamai Connected Cloud, giving you access to **30+ global data centers** spanning North America, Europe, Asia-Pacific, South America, and Africa.

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

# Install Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash
```

This should automatically trigger the onboarding wizard.

The wizard will walk you through:

- Model auth (API keys or OAuth)
- Channel setup (Telegram, WhatsApp, Discord, etc.)
- Gateway token (auto-generated)
- Daemon installation (systemd)

## 4) Verify the Gateway

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 5) Access the Dashboard

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

## 6) Connect Your Channels

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login --channel whatsapp
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

Linode offers automated backups for $2/month on the Nanode plan. Alternatively, use the built-in backup command:

```bash
openclaw backup create --output /tmp/openclaw-backup.tar.gz
```

This correctly resolves symlinks and workspace paths, even if you have moved the workspace to Block Storage.

### Resize

If you outgrow the Nanode, you can resize to a larger plan directly from the Cloud Manager without re-provisioning. The 2GB Dedicated CPU plan is a good next step for heavier workloads.

---

## Going further with Linode

### Object Storage for offsite backups ($5/mo)

OpenClaw's built-in backup CLI produces tar.gz archives. Pair it with [Linode Object Storage](https://www.linode.com/products/object-storage/) (S3-compatible) for automated offsite backups:

```bash
# Install s3cmd
apt install -y s3cmd

# Configure with your Linode Object Storage credentials
s3cmd --configure

# Create a backup with a unique filename and upload
BACKUP="/tmp/openclaw-backup-$(date +%F).tar.gz"
openclaw backup create --output "$BACKUP"
s3cmd put "$BACKUP" s3://your-bucket/openclaw/
rm "$BACKUP"
```

Automate this with a cron job for daily offsite backups.

### Block Storage for workspace expansion ($0.10/GB/mo)

The Nanode's 25GB SSD can fill up with large agent workspaces. Attach a [Linode Block Storage](https://www.linode.com/products/block-storage/) volume for expandable persistent storage:

```bash
# After attaching a volume via Cloud Manager:
mkfs.ext4 /dev/disk/by-id/scsi-0Linode_Volume_openclaw-data
mkdir -p /mnt/openclaw-data
mount /dev/disk/by-id/scsi-0Linode_Volume_openclaw-data /mnt/openclaw-data
echo '/dev/disk/by-id/scsi-0Linode_Volume_openclaw-data /mnt/openclaw-data ext4 defaults 0 2' >> /etc/fstab

# Move workspace to the volume
mv ~/.openclaw/workspace /mnt/openclaw-data/workspace
ln -s /mnt/openclaw-data/workspace ~/.openclaw/workspace
```

### GPU instances for local model inference

Instead of paying per-token for API-based models, run self-hosted LLMs on [Linode GPU instances](https://www.linode.com/products/gpu/):

| GPU                           | VRAM  | Price/mo |
| ----------------------------- | ----- | -------- |
| NVIDIA RTX 4000 Ada           | 20 GB | $350     |
| NVIDIA Quadro RTX 6000        | 24 GB | $1,000   |
| NVIDIA RTX PRO 6000 Blackwell | 96 GB | $1,665   |

This is a good option if you need data privacy (no API calls leaving your infrastructure) or want predictable costs at high usage volumes. Point OpenClaw at a local model server (e.g., Ollama, vLLM) running on the same instance.

### LKE (Kubernetes) for production deployments

OpenClaw ships [Kubernetes manifests](/install/kubernetes) out of the box. [Linode Kubernetes Engine (LKE)](https://www.linode.com/products/kubernetes/) gives you a managed control plane:

- **Free base cluster** — pay only for worker nodes
- **$60/mo HA control plane** — for production reliability
- **NodeBalancers** ($10/mo) auto-provision as Kubernetes `LoadBalancer` services for TLS termination

### VLANs for private networking (free)

Running OpenClaw alongside other services (monitoring, databases, model servers)? [Linode VLANs](https://www.linode.com/products/vlan/) provide isolated Layer 2 networking between your instances at no extra cost.

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
journalctl --user -u openclaw-gateway.service --no-pager -n 50
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
