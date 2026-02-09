---
summary: "OpenClaw sa Raspberry Pi (budget na self-hosted na setup)"
read_when:
  - Pagse-set up ng OpenClaw sa isang Raspberry Pi
  - Pagpapatakbo ng OpenClaw sa mga ARM device
  - Pagbuo ng murang, laging-on na personal AI
title: "Raspberry Pi"
---

# OpenClaw sa Raspberry Pi

## Layunin

Magpatakbo ng persistent, laging-on na OpenClaw Gateway sa isang Raspberry Pi para sa **~$35-80** na one-time cost (walang buwanang bayarin).

Perpekto para sa:

- 24/7 na personal AI assistant
- Home automation hub
- Low-power, laging-available na Telegram/WhatsApp bot

## Mga Kinakailangan sa Hardware

| Pi Model        | RAM     | Gumagana?       | Mga Tala                            |
| --------------- | ------- | --------------- | ----------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ Pinakamahusay | Pinakamabilis, inirerekomenda       |
| **Pi 4**        | 4GB     | ✅ Maganda       | Sweet spot para sa karamihan        |
| **Pi 4**        | 2GB     | ✅ OK            | Gumagana, magdagdag ng swap         |
| **Pi 4**        | 1GB     | ⚠️ Sikip        | Posible may swap, minimal na config |
| **Pi 3B+**      | 1GB     | ⚠️ Mabagal      | Gumagana pero mabagal               |
| **Pi Zero 2 W** | 512MB   | ❌               | Hindi inirerekomenda                |

**Minimum na specs:** 1GB RAM, 1 core, 500MB disk  
**Inirerekomenda:** 2GB+ RAM, 64-bit OS, 16GB+ SD card (o USB SSD)

## Mga Kailangan Mo

- Raspberry Pi 4 o 5 (2GB+ inirerekomenda)
- MicroSD card (16GB+) o USB SSD (mas mahusay ang performance)
- Power supply (inirerekomenda ang opisyal na Pi PSU)
- Network connection (Ethernet o WiFi)
- ~30 minuto

## 1. I-flash ang OS

Gamitin ang **Raspberry Pi OS Lite (64-bit)** — walang desktop na kailangan para sa headless server.

1. I-download ang [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Piliin ang OS: **Raspberry Pi OS Lite (64-bit)**
3. I-click ang gear icon (⚙️) para mag-pre-configure:
   - Itakda ang hostname: `gateway-host`
   - I-enable ang SSH
   - Itakda ang username/password
   - I-configure ang WiFi (kung hindi gagamit ng Ethernet)
4. I-flash sa iyong SD card / USB drive
5. Ipasok at i-boot ang Pi

## 2) Kumonekta via SSH

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. System Setup

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. I-install ang Node.js 22 (ARM64)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. Magdagdag ng Swap (Mahalaga para sa 2GB o mas mababa)

Pinipigilan ng swap ang out-of-memory crashes:

```bash
# Create 2GB swap file
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Optimize for low RAM (reduce swappiness)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6. I-install ang OpenClaw

### Option A: Standard Install (Inirerekomenda)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Option B: Hackable Install (Para sa pag-eeksperimento)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

Ang hackable install ay nagbibigay ng direktang access sa mga log at code — kapaki-pakinabang para sa pag-debug ng mga ARM-specific na isyu.

## 7. Patakbuhin ang Onboarding

```bash
openclaw onboard --install-daemon
```

Sundin ang wizard:

1. **Gateway mode:** Local
2. **Auth:** Inirerekomenda ang API keys (maaaring maging maselan ang OAuth sa headless Pi)
3. **Channels:** Telegram ang pinakamadaling simulan
4. **Daemon:** Oo (systemd)

## 8) I-verify ang Installation

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. I-access ang Dashboard

Dahil headless ang Pi, gumamit ng SSH tunnel:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

O gumamit ng Tailscale para sa laging-on na access:

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## Mga Optimization sa Performance

### Gumamit ng USB SSD (Malaking Pagbuti)

Mabagal ang mga SD card at madaling masira. Malaki ang ipinapahusay ng isang USB SSD ang performance:

```bash
# Check if booting from USB
lsblk
```

Tingnan ang [Pi USB boot guide](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) para sa setup.

### Bawasan ang Paggamit ng Memory

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### I-monitor ang Resources

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## Mga Tala na Partikular sa ARM

### Binary Compatibility

Karamihan sa mga tampok ng OpenClaw ay gumagana sa ARM64, pero maaaring kailanganin ng ARM builds ang ilang external binaries:

| Tool                                  | Status sa ARM64 | Mga Tala                            |
| ------------------------------------- | --------------- | ----------------------------------- |
| Node.js               | ✅               | Mahusay na gumagana                 |
| WhatsApp (Baileys) | ✅               | Pure JS, walang isyu                |
| Telegram                              | ✅               | Pure JS, walang isyu                |
| gog (Gmail CLI)    | ⚠️              | Tingnan kung may ARM release        |
| Chromium (browser) | ✅               | `sudo apt install chromium-browser` |

Kung pumalya ang isang skill, tingnan kung may ARM build ang binary nito. Many Go/Rust tools do; some don't.

### 32-bit vs 64-bit

**Palaging gumamit ng 64-bit OS.** Kinakailangan ito ng Node.js at ng maraming modernong tool. Suriin gamit ang:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## Inirerekomendang Setup ng Model

Dahil ang Pi ay Gateway lamang (ang mga model ay tumatakbo sa cloud), gumamit ng mga API-based na model:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-20250514",
        "fallbacks": ["openai/gpt-4o-mini"]
      }
    }
  }
}
```

**Don't try to run local LLMs on a Pi** — even small models are too slow. Let Claude/GPT do the heavy lifting.

---

## Auto-Start sa Boot

Inaayos ito ng onboarding wizard, pero para i-verify:

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## Pag-troubleshoot

### Out of Memory (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### Mabagal na Performance

- Gumamit ng USB SSD sa halip na SD card
- I-disable ang mga hindi ginagamit na serbisyo: `sudo systemctl disable cups bluetooth avahi-daemon`
- Suriin ang CPU throttling: `vcgencmd get_throttled` (dapat magbalik ng `0x0`)

### Hindi Nagsisimula ang Serbisyo

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### Mga Isyu sa ARM Binary

Kung pumalya ang isang skill na may "exec format error":

1. Tingnan kung may ARM64 build ang binary
2. Subukang i-build mula sa source
3. O gumamit ng Docker container na may ARM support

### Nawawala ang WiFi

Para sa mga headless Pi na nasa WiFi:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## Paghahambing ng Gastos

| Setup                             | One-Time Cost        | Buwanang Gastos             | Mga Tala                                                 |
| --------------------------------- | -------------------- | --------------------------- | -------------------------------------------------------- |
| **Pi 4 (2GB)** | ~$45 | $0                          | + kuryente (~$5/taon) |
| **Pi 4 (4GB)** | ~$55 | $0                          | Inirerekomenda                                           |
| **Pi 5 (4GB)** | ~$60 | $0                          | Pinakamahusay na performance                             |
| **Pi 5 (8GB)** | ~$80 | $0                          | Sobra pero handa sa hinaharap                            |
| DigitalOcean                      | $0                   | $6/buwan                    | $72/taon                                                 |
| Hetzner                           | $0                   | €3.79/buwan | ~$50/taon                                |

**Break-even:** Nababayaran ng Pi ang sarili nito sa loob ng ~6-12 buwan kumpara sa cloud VPS.

---

## Tingnan Din

- [Linux guide](/platforms/linux) — pangkalahatang Linux setup
- [DigitalOcean guide](/platforms/digitalocean) — cloud na alternatibo
- [Hetzner guide](/install/hetzner) — Docker setup
- [Tailscale](/gateway/tailscale) — remote access
- [Nodes](/nodes) — ipares ang iyong laptop/telepono sa Pi gateway
