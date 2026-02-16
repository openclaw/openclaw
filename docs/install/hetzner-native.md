---
summary: "Run OpenClaw 24/7 on a Hetzner VPS (native install) with Tailscale and Telegram"
read_when:
  - You want OpenClaw running 24/7 as a personal assistant on a cheap VPS
  - You want a native (non-Docker) install on Hetzner with Tailscale networking
  - You want to set up Telegram as the primary messaging channel
  - You want a secure, no-public-ports VPS deployment
title: "Hetzner (Native + Tailscale)"
---

# OpenClaw on Hetzner (Native, Tailscale, Telegram)

## Goal

Run a persistent OpenClaw Gateway on a Hetzner CX22 VPS using a **native install** (no Docker), secured with **Tailscale** (no public ports), and accessible via **Telegram**.

If you want "OpenClaw as a personal AI assistant for ~$4/mo", this is the guide.

For the Docker-based Hetzner deployment, see [Hetzner (Docker)](/install/hetzner).

## What are we doing (simple terms)?

- Rent a small Linux server (Hetzner CX22, ~$4/mo)
- Harden SSH, firewall, and swap
- Install Tailscale for private networking (replace public SSH)
- Install OpenClaw natively (Node.js + systemd)
- Expose the Control UI via Tailscale Serve (HTTPS, no public ports)
- Set up a Telegram bot for messaging

Total time: ~30 minutes.

---

## Why native over Docker?

On a 4GB VPS, native install saves ~300–500MB of RAM that Docker would consume. It also simplifies updates (`curl | bash` instead of image rebuilds) and debugging (`journalctl` instead of `docker logs`).

If you prefer Docker, see [Hetzner (Docker)](/install/hetzner).

---

## What you need

- Hetzner Cloud account ([signup](https://console.hetzner.cloud/))
- Tailscale account ([signup](https://tailscale.com) — free personal plan)
- SSH key pair on your laptop
- Telegram account
- Anthropic API key (or another model provider)
- ~30 minutes

---

## 1) Provision the VPS

Create a **CX22** instance in Hetzner Cloud Console:

| Setting | Value |
|---|---|
| **OS** | Ubuntu 24.04 LTS |
| **Type** | CX22 (2 vCPU, 4GB RAM, 40GB SSD) |
| **Region** | Closest to you (Falkenstein/Nuremberg for EU, Ashburn for US) |
| **SSH key** | Add your public key |
| **Hostname** | `openclaw` |

Connect as root:

```bash
ssh root@YOUR_VPS_IP
```

---

## 2) Harden the VPS

Run the hardening script, or follow the manual steps below.

### Automated

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/vps-hetzner-setup.sh | bash
```

### Manual steps

<AccordionGroup>
  <Accordion title="Create dedicated user" defaultOpen>

```bash
adduser --disabled-password --gecos "" openclaw
usermod -aG sudo openclaw

# Allow passwordless sudo for setup
echo "openclaw ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/openclaw

# Copy SSH keys
mkdir -p /home/openclaw/.ssh
cp /root/.ssh/authorized_keys /home/openclaw/.ssh/
chown -R openclaw:openclaw /home/openclaw/.ssh
chmod 700 /home/openclaw/.ssh
chmod 600 /home/openclaw/.ssh/authorized_keys
```

  </Accordion>

  <Accordion title="Harden SSH">

```bash
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config
systemctl restart sshd
```

Verify you can still connect in a **new terminal** before closing root:

```bash
ssh openclaw@YOUR_VPS_IP
```

  </Accordion>

  <Accordion title="Configure firewall (UFW)">

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment "SSH (temporary, remove after Tailscale)"
ufw allow 41641/udp comment "Tailscale"
ufw --force enable
```

  </Accordion>

  <Accordion title="Add 2GB swap">

Even with 4GB RAM, swap provides an OOM safety net during builds or spikes.

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Verify: `free -h` should show 2G swap.

  </Accordion>

  <Accordion title="Enable unattended security updates">

```bash
apt-get update && apt-get install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

  </Accordion>
</AccordionGroup>

From here on, work as the `openclaw` user:

```bash
su - openclaw
```

---

## 3) Install Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

- `--ssh` enables Tailscale SSH (no more need for port 22)
- Follow the auth URL printed in the terminal to approve the device

Verify from your **laptop** (must be on the same tailnet):

```bash
ssh openclaw@openclaw
```

If that works, **remove public SSH** from UFW:

```bash
sudo ufw delete allow 22/tcp
```

Optionally disable sshd entirely:

```bash
sudo systemctl disable --now ssh
```

---

## 4) Install OpenClaw

```bash
# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash
```

When the onboarding wizard runs:

1. Enter your **Anthropic API key** (or other provider credentials)
2. Select **Install Gateway daemon** when prompted (creates systemd user service)
3. Complete the wizard

Enable lingering so the user service survives logout:

```bash
sudo loginctl enable-linger openclaw
```

Verify:

```bash
openclaw --version
systemctl --user status openclaw-gateway
```

---

## 5) Configure Gateway for Tailscale

```bash
# Keep Gateway on loopback (not publicly reachable)
openclaw config set gateway.bind loopback

# Expose via Tailscale Serve (HTTPS + identity-aware auth)
openclaw config set gateway.tailscale.mode serve

# Trust loopback proxy headers from Tailscale Serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

# Restart to apply
systemctl --user restart openclaw-gateway
```

Access the Control UI from any device on your tailnet:

```
https://openclaw.<tailnet-name>.ts.net/
```

Replace `<tailnet-name>` with your tailnet name (visible in `tailscale status`).

No SSH tunnel needed. Tailscale provides HTTPS encryption, automatic certs, and identity-based auth.

For full Tailscale config options, see [Tailscale integration](/gateway/tailscale).

---

## 6) Set up Telegram bot

<Steps>
  <Step title="Create bot via BotFather">

Open Telegram and chat with **@BotFather** (verify the handle is exactly `@BotFather`).

1. Send `/newbot`
2. Follow prompts to name your bot
3. Save the bot token

Optional: disable group joins if DM-only:

- Send `/setjoingroups` to BotFather
- Select your bot, then **Disable**

  </Step>

  <Step title="Register bot token with OpenClaw">

```bash
openclaw channels add --channel telegram --token "YOUR_BOT_TOKEN"
```

  </Step>

  <Step title="Pair your Telegram account">

1. Send any message to your bot in Telegram
2. Approve the pairing:

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

Pairing codes expire after 1 hour.

  </Step>

  <Step title="Verify">

Send a message to your bot. You should get a response.

Telegram uses **long polling** (outbound connections only) — no inbound ports or webhooks needed.

  </Step>
</Steps>

For full Telegram configuration (groups, streaming, commands, etc.), see [Telegram](/channels/telegram).

---

## 7) Security hardening

### Run the security audit

```bash
openclaw security audit --deep --fix
```

This auto-fixes common issues: file permissions, group policies, credential exposure.

### Disable mDNS

No local network to discover on a VPS:

```bash
openclaw config set discovery.mdns.mode off
```

### Verify no public ports

```bash
sudo ss -tlnp | grep -v '127.0.0.1\|::1'
```

This should return empty (or only Tailscale-related entries).

### Verify file permissions

The audit auto-fixes these, but verify:

```bash
ls -la ~/.openclaw/
# Expected: drwx------ (700)
ls -la ~/.openclaw/openclaw.json
# Expected: -rw------- (600)
```

For the full security checklist, see [Security](/gateway/security/).

---

## 8) Verify everything

```bash
# Gateway running
systemctl --user status openclaw-gateway
openclaw status

# Tailscale active
tailscale status

# Security posture
openclaw security audit --deep

# Send a test message via Telegram to your bot
```

---

## Ongoing maintenance

| Task | Command | Frequency |
|---|---|---|
| Update OpenClaw | `curl -fsSL https://openclaw.ai/install.sh \| bash` | As needed |
| OS security updates | Automatic (unattended-upgrades) | Daily |
| Check gateway health | `openclaw health --token TOKEN` | Cron (every 5 min) |
| Backup config | `tar -czvf ~/backup-$(date +%Y%m%d).tar.gz ~/.openclaw` | Weekly cron |
| Review Tailscale devices | [Tailscale admin console](https://login.tailscale.com/admin) | Monthly |
| Security audit | `openclaw security audit --deep` | Monthly |
| Prune old sessions | Clean `~/.openclaw/agents/*/sessions/` | As disk fills |

### Health check cron

```bash
crontab -e
```

Add:

```cron
*/5 * * * * openclaw health --token "YOUR_GATEWAY_TOKEN" >> /tmp/openclaw-health.log 2>&1
```

### Weekly backup cron

```cron
0 3 * * 0 tar -czvf ~/backup-$(date +\%Y\%m\%d).tar.gz ~/.openclaw 2>&1 | logger -t openclaw-backup
```

---

## Monthly cost

| Item | Cost |
|---|---|
| Hetzner CX22 | ~$4/mo |
| Tailscale | Free (personal plan, up to 100 devices) |
| Anthropic API | Usage-based |
| **Total infrastructure** | **~$4/mo** |

---

## Troubleshooting

<AccordionGroup>
  <Accordion title="Gateway won't start">

```bash
systemctl --user status openclaw-gateway
journalctl --user -u openclaw-gateway -n 50
openclaw doctor --non-interactive
```

  </Accordion>

  <Accordion title="Tailscale won't connect">

```bash
sudo tailscale status
# Re-authenticate if needed
sudo tailscale up --ssh --hostname=openclaw --reset
```

  </Accordion>

  <Accordion title="Can't reach Control UI">

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

  </Accordion>

  <Accordion title="Telegram bot not responding">

```bash
# Check channel status
openclaw channels status

# Check logs for Telegram errors
openclaw logs --follow

# Verify bot token
openclaw doctor --non-interactive
```

Common causes:
- Bot token incorrect or revoked
- Pairing not approved (`openclaw pairing list telegram`)
- DNS issues reaching `api.telegram.org`

  </Accordion>

  <Accordion title="Out of memory">

```bash
free -h
# If swap is not active:
sudo swapon /swapfile

# Check what's using memory
ps aux --sort=-%mem | head -10
```

If persistent, upgrade to CX32 (4 vCPU, 8GB RAM, ~$7/mo).

  </Accordion>
</AccordionGroup>

---

## Persistence

All state lives in `~/.openclaw/`:

| Component | Location | Notes |
|---|---|---|
| Gateway config | `~/.openclaw/openclaw.json` | Main config file |
| Model auth | `~/.openclaw/agents/*/agent/auth-profiles.json` | API keys, OAuth tokens |
| Credentials | `~/.openclaw/credentials/` | Channel credentials |
| Sessions | `~/.openclaw/agents/*/sessions/` | Conversation history |
| Workspace | `~/.openclaw/workspace/` | Agent artifacts |

Back up periodically:

```bash
tar -czvf ~/openclaw-backup-$(date +%Y%m%d).tar.gz ~/.openclaw
```

---

## See also

- [Hetzner (Docker)](/install/hetzner) — Docker-based alternative
- [Oracle Cloud](/platforms/oracle) — free ARM VPS (similar Tailscale pattern)
- [Tailscale integration](/gateway/tailscale) — full Tailscale Serve/Funnel docs
- [Telegram](/channels/telegram) — full Telegram bot configuration
- [Security](/gateway/security/) — security hardening checklist
- [Gateway configuration](/gateway/configuration) — all config options
