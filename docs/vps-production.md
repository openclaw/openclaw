---
summary: "Production VPS deployment guide with systemd, monitoring, and security hardening"
read_when:
  - Running OpenClaw 24/7 on a VPS
  - Setting up systemd for OpenClaw
  - Hardening a production OpenClaw deployment
title: "Production VPS Deployment"
---

# Production VPS Deployment Guide

A practical guide for running OpenClaw 24/7 on a VPS (Hetzner, DigitalOcean, Linode, etc.) with hardened configuration, systemd management, and monitoring.

## Prerequisites

- A VPS with Ubuntu 22.04+ or Debian 12+ (minimum 2GB RAM, 1 vCPU)
- Node.js v22+ installed
- A domain name (optional but recommended for remote access)
- An Anthropic or OpenRouter API key

For detailed installation steps, see the [Install guide](/install).

## Running as a systemd Service

Don't run OpenClaw in a tmux/screen session — use systemd for automatic restarts and boot persistence.

Create a dedicated user:

```bash
sudo useradd -r -m -s /bin/bash openclaw
sudo -u openclaw openclaw setup
```

Create `/etc/systemd/system/openclaw.service`:

```ini
[Unit]
Description=OpenClaw Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=openclaw
WorkingDirectory=/home/openclaw
ExecStart=/usr/local/bin/openclaw gateway run
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable openclaw
sudo systemctl start openclaw
sudo systemctl status openclaw
```

View logs:

```bash
journalctl -u openclaw -f
```

## Remote Access via Tailscale

[Tailscale](https://tailscale.com/) provides secure remote access to the OpenClaw Control UI without exposing ports to the internet.

```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Serve the Control UI over HTTPS
tailscale serve https / http://localhost:18789
```

Access the Control UI at the machine's Tailscale hostname (visible in your Tailscale admin console or via `tailscale status`).

## Cron Watchdog

OpenClaw's cron scheduler can occasionally stall. A simple watchdog script ensures it stays healthy:

```bash
#!/bin/bash
# /usr/local/bin/openclaw-watchdog.sh
# Add to system crontab: */30 * * * * /usr/local/bin/openclaw-watchdog.sh

LAST_CRON=$(find /tmp/openclaw-cron-* -maxdepth 0 -mmin -240 2>/dev/null | head -1)
if [ -z "$LAST_CRON" ]; then
    echo "$(date): Cron scheduler appears stalled, restarting gateway"
    systemctl restart openclaw
fi
```

## Disk and Memory Monitoring

Add basic resource monitoring to catch issues before they cause problems:

```bash
# Check disk usage
DISK_PCT=$(df / | awk 'NR==2 {print $5}' | tr -d '%')
if [ "$DISK_PCT" -gt 85 ]; then
    echo "Warning: Disk usage at ${DISK_PCT}%"
fi

# Check available memory
MEM_FREE=$(free | awk '/Mem:/ {printf "%.0f", $7/$2 * 100}')
if [ "$MEM_FREE" -lt 10 ]; then
    echo "Warning: Only ${MEM_FREE}% memory free"
fi
```

## Backup Strategy

Back up your configuration and workspace regularly:

```bash
# Backup OpenClaw config
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%Y%m%d)

# Backup workspace (MEMORY.md, skills, credentials)
tar czf ~/backups/workspace-$(date +%Y%m%d).tar.gz \
    ~/your-workspace/MEMORY.md \
    ~/your-workspace/memory/ \
    ~/your-workspace/SOUL.md \
    ~/your-workspace/AGENTS.md
```

## Security Checklist

- [ ] Create a dedicated `openclaw` user — don't run as root
- [ ] Change the default SSH port and disable password authentication
- [ ] Enable UFW firewall: `ufw allow ssh && ufw allow 443/tcp && ufw enable`
- [ ] Keep API keys in environment variables or a credentials directory with `chmod 600`
- [ ] Use Tailscale or Cloudflare Tunnel instead of exposing ports directly
- [ ] Set up unattended security updates: `apt install unattended-upgrades`

## Updating OpenClaw

```bash
# Check current version
openclaw --version

# Update to latest
npm update -g openclaw

# Restart the service
sudo systemctl restart openclaw
```

## Troubleshooting

| Issue                | Fix                                                    |
| -------------------- | ------------------------------------------------------ |
| Gateway won't start  | Check `openclaw doctor` for config errors              |
| Cron jobs not firing | Restart gateway; check watchdog script                 |
| High memory usage    | Reduce `compaction` settings or restart periodically   |
| Channel disconnected | Check API keys, restart gateway                        |
| Disk filling up      | Clean old logs: `journalctl --vacuum-time=7d`          |

## Tips from Production

- **One config change at a time.** Validate with `openclaw doctor` before restarting.
- **Back up before updating.** Major version updates can change config schema.
- **Use cron for precise timing, heartbeats for batched checks.** Don't create 10 cron jobs when one heartbeat can do the same work.
- **Monitor your API spend.** Set up daily cost reports to avoid surprise bills.
