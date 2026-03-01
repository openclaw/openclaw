---
title: "Dedicated Hardware"
description: "Run OpenClaw on dedicated hardware — always-on, private, no cloud needed."
---

# Dedicated hardware

Running OpenClaw on dedicated hardware gives you an always-on assistant with full privacy — no cloud server, no monthly hosting fees, and complete control over your data.

## Why dedicated hardware?

| Benefit                | Details                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| **Always-on**          | Runs 24/7 without keeping a laptop open or paying for a VPS           |
| **Privacy**            | Everything stays on your local network — no data leaves your device   |
| **Low power**          | ARM devices like the NVIDIA Jetson draw 7–15W (less than a lightbulb) |
| **No recurring costs** | One-time hardware purchase vs. monthly cloud bills                    |
| **Full capabilities**  | Browser automation, file access, cron jobs — everything works         |

## Recommended devices

### NVIDIA Jetson Orin Nano

The best balance of performance and power efficiency for OpenClaw:

- **AI performance**: 40 TOPS (useful for local vision/inference tasks)
- **RAM**: 8 GB shared CPU/GPU
- **Power**: 7–15W
- **Storage**: NVMe SSD slot (256 GB+ recommended)
- **OS**: Ubuntu 22.04 (JetPack)

OpenClaw runs entirely on the CPU — the GPU is a bonus for local model inference or vision tasks.

**Setup:**

```bash
# Install Node.js 22+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install OpenClaw
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

### Raspberry Pi 5

A budget-friendly option that handles OpenClaw well:

- **RAM**: 4 GB or 8 GB
- **Power**: 3–12W
- **Storage**: microSD or USB SSD (SSD strongly recommended)
- **OS**: Raspberry Pi OS (64-bit) or Ubuntu Server

```bash
# Same install steps as above
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

### Mini PCs (Intel N100, etc.)

Any x86 mini PC with 8 GB+ RAM works great. Popular choices:

- Intel N100-based mini PCs (15–25W)
- Used Dell Micro / HP Mini / Lenovo Tiny (under $100 on eBay)
- Intel NUC or similar

These offer the easiest setup since they run standard Ubuntu/Debian with no ARM quirks.

## Pre-built option: ClawBox

If you want a plug-and-play solution, [ClawBox](https://openclawhardware.dev) ships with OpenClaw pre-installed on an NVIDIA Jetson Orin Nano with a 512 GB NVMe SSD. Unbox, connect to Wi-Fi, and your assistant is running.

## Tips for hardware setups

### Use an SSD

SD cards wear out fast with OpenClaw's session writes. Always use an SSD (NVMe or USB) for the root filesystem or at least for `~/.openclaw/`.

### Set up systemd

The onboarding wizard (`openclaw onboard --install-daemon`) installs a systemd user service automatically. Verify it's running:

```bash
systemctl --user status openclaw-gateway
```

To start on boot (even without logging in):

```bash
sudo loginctl enable-linger $USER
```

### Remote access

Since headless devices don't have a monitor, set up remote access:

- **Tailscale** (recommended): Zero-config VPN mesh. Install on the device and your phone/laptop. Access the Gateway via `http://<tailscale-ip>:18789`.
- **SSH tunnel**: `ssh -L 18789:localhost:18789 user@device-ip`

See [Gateway remote access](/gateway/remote) for details.

### Browser automation

For browser tool support on headless devices:

```bash
# Install Chromium
sudo apt-get install -y chromium-browser

# OpenClaw will launch it headless automatically
```

On Jetson devices, use the `chromium-browser` package from the Ubuntu repos. On Raspberry Pi, it's pre-installed with Raspberry Pi OS Desktop.

### Keep it cool

Fanless setups work fine for OpenClaw (it's not compute-heavy), but ensure some airflow. A small heatsink is enough for the Jetson; the Pi 5 benefits from the official active cooler.

## Comparison: hardware vs. cloud

|                        | Dedicated hardware             | Cloud VPS           |
| ---------------------- | ------------------------------ | ------------------- |
| **Upfront cost**       | $50–400 (one-time)             | $0                  |
| **Monthly cost**       | ~$1–3 electricity              | $5–20/month         |
| **Privacy**            | Full — data stays local        | Provider can access |
| **Latency**            | LAN-speed                      | Internet round-trip |
| **Maintenance**        | You handle updates             | You handle updates  |
| **Browser automation** | Full support                   | Requires setup      |
| **Uptime**             | Depends on your power/internet | 99.9%+ SLA          |

For most personal use, dedicated hardware pays for itself within 6–12 months compared to a VPS.
