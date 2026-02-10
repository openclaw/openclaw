---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "OpenClaw on DigitalOcean (simple paid VPS option)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up OpenClaw on DigitalOcean（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Looking for cheap VPS hosting for OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "DigitalOcean"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenClaw on DigitalOcean（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run a persistent OpenClaw Gateway on DigitalOcean for **$6/month** (or $4/mo with reserved pricing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want a $0/month option and don’t mind ARM + provider-specific setup, see the [Oracle Cloud guide](/platforms/oracle).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cost Comparison (2026)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Provider     | Plan            | Specs                  | Price/mo    | Notes                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------ | --------------- | ---------------------- | ----------- | ------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Oracle Cloud | Always Free ARM | up to 4 OCPU, 24GB RAM | $0          | ARM, limited capacity / signup quirks |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Hetzner      | CX22            | 2 vCPU, 4GB RAM        | €3.79 (~$4) | Cheapest paid option                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM        | $6          | Easy UI, good docs                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM        | $6          | Many locations                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Linode       | Nanode          | 1 vCPU, 1GB RAM        | $5          | Now part of Akamai                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Picking a provider:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DigitalOcean: simplest UX + predictable setup (this guide)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hetzner: good price/perf (see [Hetzner guide](/install/hetzner))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Oracle Cloud: can be $0/month, but is more finicky and ARM-only (see [Oracle guide](/platforms/oracle))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prerequisites（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DigitalOcean account ([signup with $200 free credit](https://m.do.co/c/signup))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SSH key pair (or willingness to use password auth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ~20 minutes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 1) Create a Droplet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Log into [DigitalOcean](https://cloud.digitalocean.com/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Click **Create → Droplets**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Choose:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Region:** Closest to you (or your users)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Image:** Ubuntu 24.04 LTS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Size:** Basic → Regular → **$6/mo** (1 vCPU, 1GB RAM, 25GB SSD)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Authentication:** SSH key (recommended) or password（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Click **Create Droplet**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Note the IP address（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2) Connect via SSH（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh root@YOUR_DROPLET_IP（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 3) Install OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Update system（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
apt update && apt upgrade -y（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Install Node.js 22（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
apt install -y nodejs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Install OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://openclaw.ai/install.sh | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Verify（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 4) Run Onboarding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --install-daemon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The wizard will walk you through:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model auth (API keys or OAuth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel setup (Telegram, WhatsApp, Discord, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway token (auto-generated)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Daemon installation (systemd)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 5) Verify the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check service（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
systemctl --user status openclaw-gateway.service（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# View logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
journalctl --user -u openclaw-gateway.service -f（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 6) Access the Dashboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The gateway binds to loopback by default. To access the Control UI:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option A: SSH Tunnel (recommended)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# From your local machine（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Then open: http://localhost:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option B: Tailscale Serve (HTTPS, loopback-only)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# On the droplet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://tailscale.com/install.sh | sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tailscale up（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Configure Gateway to use Tailscale Serve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set gateway.tailscale.mode serve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open: `https://<magicdns>/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Serve keeps the Gateway loopback-only and authenticates via Tailscale identity headers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- To require token/password instead, set `gateway.auth.allowTailscale: false` or use `gateway.auth.mode: "password"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option C: Tailnet bind (no Serve)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set gateway.bind tailnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open: `http://<tailscale-ip>:18789` (token required).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 7) Connect Your Channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Telegram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing list telegram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing approve telegram <CODE>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### WhatsApp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels login whatsapp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Scan QR code（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Channels](/channels) for other providers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Optimizations for 1GB RAM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The $6 droplet only has 1GB RAM. To keep things running smoothly:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Add swap (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fallocate -l 2G /swapfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
chmod 600 /swapfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mkswap /swapfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
swapon /swapfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo '/swapfile none swap sw 0 0' >> /etc/fstab（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Use a lighter model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you're hitting OOMs, consider:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Using API-based models (Claude, GPT) instead of local models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Setting `agents.defaults.model.primary` to a smaller model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Monitor memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
free -h（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
htop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Persistence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All state lives in:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/` — config, credentials, session data（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/workspace/` — workspace (SOUL.md, memory, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These survive reboots. Back them up periodically:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Oracle Cloud Free Alternative（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Oracle Cloud offers **Always Free** ARM instances that are significantly more powerful than any paid option here — for $0/month.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| What you get      | Specs                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------- | ---------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **4 OCPUs**       | ARM Ampere A1          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **24GB RAM**      | More than enough       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **200GB storage** | Block volume           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Forever free**  | No credit card charges |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Caveats:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Signup can be finicky (retry if it fails)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ARM architecture — most things work, but some binaries need ARM builds（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For the full setup guide, see [Oracle Cloud](/platforms/oracle). For signup tips and troubleshooting the enrollment process, see this [community guide](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Gateway won't start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor --non-interactive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
journalctl -u openclaw --no-pager -n 50（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Port already in use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lsof -i :18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
kill <PID>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Out of memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
free -h（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Add more swap（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Or upgrade to $12/mo droplet (2GB RAM)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## See Also（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Hetzner guide](/install/hetzner) — cheaper, more powerful（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Docker install](/install/docker) — containerized setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Tailscale](/gateway/tailscale) — secure remote access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Configuration](/gateway/configuration) — full config reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
