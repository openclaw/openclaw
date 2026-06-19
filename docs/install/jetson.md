---
summary: "Host OpenClaw on an NVIDIA Jetson for always-on edge self-hosting"
read_when:
  - Setting up OpenClaw on NVIDIA Jetson hardware
  - Running OpenClaw on ARM64 edge devices
  - Building an always-on edge AI appliance
title: "NVIDIA Jetson"
---

Run a persistent, always-on OpenClaw Gateway on an NVIDIA Jetson module. Jetson devices are ARM64 single-board computers designed for edge workloads — they handle the Gateway easily since models run in the cloud via API. Typical hardware cost is **$150–500 one-time** (developer kit), no monthly fees.

## Hardware compatibility

| Jetson module   | RAM   | Works? | Notes                                       |
| --------------- | ----- | ------ | ------------------------------------------- |
| AGX Orin 64GB   | 64 GB | Best   | Fastest, best for heavy multi-agent setups. |
| AGX Orin 32GB   | 32 GB | Best   | Excellent headroom for all workloads.       |
| Orin NX 16GB    | 16 GB | Great  | Strong balance of performance and cost.     |
| Orin NX 8GB     | 8 GB  | Good   | Plenty for normal Gateway use.              |
| Orin Nano 8GB   | 8 GB  | Good   | Compact, low-power, capable.                |
| Orin Nano 4GB   | 4 GB  | OK     | Add swap; limit concurrent agents.          |
| AGX Xavier 32GB | 32 GB | Good   | Older but still capable.                    |
| Xavier NX       | 8 GB  | OK     | Works; JetPack 5.x required.                |

**Minimum:** 4 GB RAM, 1 core, 500 MB free disk, JetPack 5.x+ (Ubuntu 20.04/22.04).
**Recommended:** 8 GB+ RAM, NVMe SSD (32 GB+), Ethernet, JetPack 6.x.

## Prerequisites

- NVIDIA Jetson developer kit (Orin Nano, Orin NX, or AGX Orin recommended)
- NVMe SSD (32 GB+) or microSD card (64 GB+) — SSD strongly preferred
- Compatible power supply (see NVIDIA docs for your module's wattage)
- Network connection (Ethernet or WiFi)
- JetPack 5.x (Ubuntu 20.04) or JetPack 6.x (Ubuntu 22.04) — 64-bit ARM required
- About 30 minutes

## Setup

<Steps>
  <Step title="Flash JetPack">
    Use **NVIDIA SDK Manager** or the **SD card image** method to flash your Jetson module with the latest JetPack release.

    1. Download [NVIDIA SDK Manager](https://developer.nvidia.com/sdk-manager) (host PC required) or use a pre-built [JetPack SD card image](https://developer.nvidia.com/embedded/jetpack).
    2. Choose the latest stable JetPack release for your module (6.x for Orin series, 5.x for Xavier series).
    3. Pre-configure:
       - Hostname: `gateway-host`
       - Enable SSH
       - Set username and password
       - Configure WiFi (if not using Ethernet)
    4. Flash to your NVMe SSD or SD card, insert it, and boot the Jetson.

    For headless setup, the SD card image method is simpler: flash the image, insert, and boot — SSH will be available by default.

  </Step>

  <Step title="Connect via SSH">
    ```bash
    ssh user@gateway-host
    ```
  </Step>

  <Step title="Update the system">
    ```bash
    sudo apt update && sudo apt upgrade -y
    sudo apt install -y git curl build-essential

    # Set timezone (important for cron and reminders)
    sudo timedatectl set-timezone America/Chicago
    ```

  </Step>

  <Step title="Install Node.js 24">
    Jetson modules are ARM64 (aarch64). Use the standard NodeSource ARM64 package:

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt install -y nodejs
    node --version
    ```

    Verify the architecture shows `aarch64`:

    ```bash
    uname -m
    ```

  </Step>

  <Step title="Add swap (important for 8 GB or less)">
    ```bash
    sudo fallocate -l 4G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

    # Reduce swappiness for flash storage
    echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
    sudo sysctl -p
    ```

    Jetson modules with 8 GB+ rarely need swap under normal Gateway load, but it is a safe fallback for spikes.

  </Step>

  <Step title="Install OpenClaw">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash
    ```
  </Step>

  <Step title="Run onboarding">
    ```bash
    openclaw onboard --install-daemon
    ```

    Follow the wizard. API keys are recommended over OAuth for headless devices. Telegram is the easiest channel to start with.

  </Step>

  <Step title="Verify">
    ```bash
    openclaw status
    systemctl --user status openclaw-gateway.service
    journalctl --user -u openclaw-gateway.service -f
    ```
  </Step>

  <Step title="Access the Control UI">
    On your computer, get a dashboard URL from the Jetson:

    ```bash
    ssh user@gateway-host 'openclaw dashboard --no-open'
    ```

    Then create an SSH tunnel in another terminal:

    ```bash
    ssh -N -L 18789:127.0.0.1:18789 user@gateway-host
    ```

    Open the printed URL in your local browser. For always-on remote access, see [Tailscale integration](/gateway/tailscale).

  </Step>
</Steps>

## Performance tips

**Use an NVMe SSD** — SD cards are slow and wear out under sustained I/O. Most Jetson developer kits include an M.2 slot; use it for the OS and OpenClaw state. See your module's carrier board specs for supported NVMe drives.

**Set MAXN power mode** — Jetson modules default to a lower power budget. For always-on server duty, switch to MAXN:

```bash
sudo nvpmodel -m 0
```

Confirm the active mode:

```bash
sudo nvpmodel -q
```

**Enable module compile cache** — Speeds up repeated CLI invocations on embedded hosts:

```bash
grep -q 'NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache' ~/.bashrc || cat >> ~/.bashrc <<'EOF' # pragma: allowlist secret
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache
export OPENCLAW_NO_RESPAWN=1
EOF
source ~/.bashrc
```

`OPENCLAW_NO_RESPAWN=1` keeps routine Gateway restarts in-process, which avoids extra process handoffs and keeps PID tracking simple on embedded hosts.

**systemd drop-in for stable restarts** — If this Jetson is mostly running OpenClaw, add a service drop-in:

```bash
systemctl --user edit openclaw-gateway.service
```

```ini
[Service]
Environment=OPENCLAW_NO_RESPAWN=1
Environment=NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
Restart=always
RestartSec=2
TimeoutStartSec=90
```

Then `systemctl --user daemon-reload && systemctl --user restart openclaw-gateway.service`. On a headless Jetson, also enable lingering once so the user service survives logout: `sudo loginctl enable-linger "$(whoami)"`.

## Recommended model setup

Since the Jetson only runs the gateway, use cloud-hosted API models:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-6",
        "fallbacks": ["openai/gpt-5.4-mini"]
      }
    }
  }
}
```

Do not run local LLMs on a Jetson for OpenClaw workloads — the gateway is designed for API-based models, and local inference adds unnecessary complexity. Let Claude or GPT do the model work.

## ARM binary notes

Jetson modules run on ARM64 (aarch64), same as Raspberry Pi. Most OpenClaw features work without changes (Node.js, Telegram, WhatsApp/Baileys, Chromium). The binaries that occasionally lack ARM builds are typically optional Go/Rust CLI tools shipped by skills. Verify a missing binary's release page for `linux-arm64` / `aarch64` artifacts before falling back to building from source.

## Persistence and backups

OpenClaw state lives under:

- `~/.openclaw/` — `openclaw.json`, per-agent `auth-profiles.json`, channel/provider state, sessions.
- `~/.openclaw/workspace/` — agent workspace (SOUL.md, memory, artifacts).

These survive reboots. Take a portable snapshot with:

```bash
openclaw backup create
```

If you keep these on an NVMe SSD, both performance and longevity improve over an SD card.

## Troubleshooting

**Power throttling** — Run `sudo nvpmodel -q` to check the active power mode. Switch to MAXN (`-m 0`) for server duty. If throttling persists, verify your power supply meets the module's wattage.

**Thermal throttling** — Jetson modules throttle above ~90°C. For always-on workloads, add a fan or heatsink. Monitor temperature with `cat /sys/devices/virtual/thermal/thermal_zone*/temp`.

**Out of memory** — Verify swap is active with `free -h`. Limit concurrent agents. Use API-based models only (no local inference).

**Slow performance** — Use an NVMe SSD instead of an SD card. Confirm the power mode is MAXN. Enable the Node compile cache as described above.

**Service will not start** — Check logs with `journalctl --user -u openclaw-gateway.service --no-pager -n 100` and run `openclaw doctor --non-interactive`. If this is a headless Jetson, also verify lingering is enabled: `sudo loginctl enable-linger "$(whoami)"`.

**ARM binary issues** — If a skill fails with "exec format error", check whether the binary has an ARM64 build. Verify architecture with `uname -m` (should show `aarch64`).

**WiFi drops** — Disable WiFi power management: `sudo iwconfig wlan0 power off`. Or use Ethernet for reliability on always-on hosts.

## Next steps

- [Channels](/channels) — connect Telegram, WhatsApp, Discord, and more
- [Gateway configuration](/gateway/configuration) — all config options
- [Updating](/install/updating) — keep OpenClaw up to date

## Related

- [Install overview](/install)
- [Raspberry Pi](/install/raspberry-pi)
- [Linux server](/vps)
- [Platforms](/platforms)
