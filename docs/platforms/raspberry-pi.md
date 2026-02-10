---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "OpenClaw on Raspberry Pi (budget self-hosted setup)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up OpenClaw on a Raspberry Pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Running OpenClaw on ARM devices（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Building a cheap always-on personal AI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Raspberry Pi"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenClaw on Raspberry Pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run a persistent, always-on OpenClaw Gateway on a Raspberry Pi for **~$35-80** one-time cost (no monthly fees).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Perfect for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 24/7 personal AI assistant（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Home automation hub（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Low-power, always-available Telegram/WhatsApp bot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Hardware Requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Pi Model        | RAM     | Works?   | Notes                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------- | ------- | -------- | ---------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Pi 5**        | 4GB/8GB | ✅ Best  | Fastest, recommended               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Pi 4**        | 4GB     | ✅ Good  | Sweet spot for most users          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Pi 4**        | 2GB     | ✅ OK    | Works, add swap                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Pi 4**        | 1GB     | ⚠️ Tight | Possible with swap, minimal config |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Pi 3B+**      | 1GB     | ⚠️ Slow  | Works but sluggish                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Pi Zero 2 W** | 512MB   | ❌       | Not recommended                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Minimum specs:** 1GB RAM, 1 core, 500MB disk  （轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Recommended:** 2GB+ RAM, 64-bit OS, 16GB+ SD card (or USB SSD)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What You'll Need（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Raspberry Pi 4 or 5 (2GB+ recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- MicroSD card (16GB+) or USB SSD (better performance)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Power supply (official Pi PSU recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Network connection (Ethernet or WiFi)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ~30 minutes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 1) Flash the OS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use **Raspberry Pi OS Lite (64-bit)** — no desktop needed for a headless server.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Download [Raspberry Pi Imager](https://www.raspberrypi.com/software/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Choose OS: **Raspberry Pi OS Lite (64-bit)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Click the gear icon (⚙️) to pre-configure:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Set hostname: `gateway-host`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Enable SSH（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Set username/password（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Configure WiFi (if not using Ethernet)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Flash to your SD card / USB drive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Insert and boot the Pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2) Connect via SSH（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh user@gateway-host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# or use the IP address（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh user@192.168.x.x（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 3) System Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Update system（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo apt update && sudo apt upgrade -y（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Install essential packages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo apt install -y git curl build-essential（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Set timezone (important for cron/reminders)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo timedatectl set-timezone America/Chicago  # Change to your timezone（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 4) Install Node.js 22 (ARM64)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Install Node.js via NodeSource（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo apt install -y nodejs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Verify（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
node --version  # Should show v22.x.x（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm --version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 5) Add Swap (Important for 2GB or less)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Swap prevents out-of-memory crashes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Create 2GB swap file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo fallocate -l 2G /swapfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo chmod 600 /swapfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo mkswap /swapfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo swapon /swapfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Make permanent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Optimize for low RAM (reduce swappiness)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo sysctl -p（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 6) Install OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Option A: Standard Install (Recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://openclaw.ai/install.sh | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Option B: Hackable Install (For tinkering)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git clone https://github.com/openclaw/openclaw.git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm run build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm link（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The hackable install gives you direct access to logs and code — useful for debugging ARM-specific issues.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 7) Run Onboarding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --install-daemon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Follow the wizard:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Gateway mode:** Local（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Auth:** API keys recommended (OAuth can be finicky on headless Pi)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Channels:** Telegram is easiest to start with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Daemon:** Yes (systemd)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 8) Verify Installation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check service（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo systemctl status openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# View logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
journalctl -u openclaw -f（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 9) Access the Dashboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Since the Pi is headless, use an SSH tunnel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# From your laptop/desktop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh -L 18789:localhost:18789 user@gateway-host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Then open in browser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
open http://localhost:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or use Tailscale for always-on access:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# On the Pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://tailscale.com/install.sh | sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo tailscale up（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Update config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set gateway.bind tailnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo systemctl restart openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Performance Optimizations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Use a USB SSD (Huge Improvement)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SD cards are slow and wear out. A USB SSD dramatically improves performance:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check if booting from USB（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lsblk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Pi USB boot guide](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) for setup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Reduce Memory Usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Disable GPU memory allocation (headless)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Disable Bluetooth if not needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo systemctl disable bluetooth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Monitor Resources（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
free -h（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check CPU temperature（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
vcgencmd measure_temp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Live monitoring（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
htop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## ARM-Specific Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Binary Compatibility（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Most OpenClaw features work on ARM64, but some external binaries may need ARM builds:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Tool               | ARM64 Status | Notes                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------ | ------------ | ----------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Node.js            | ✅           | Works great                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| WhatsApp (Baileys) | ✅           | Pure JS, no issues                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Telegram           | ✅           | Pure JS, no issues                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| gog (Gmail CLI)    | ⚠️           | Check for ARM release               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Chromium (browser) | ✅           | `sudo apt install chromium-browser` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a skill fails, check if its binary has an ARM build. Many Go/Rust tools do; some don't.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 32-bit vs 64-bit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Always use 64-bit OS.** Node.js and many modern tools require it. Check with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
uname -m（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Should show: aarch64 (64-bit) not armv7l (32-bit)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Recommended Model Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Since the Pi is just the Gateway (models run in the cloud), use API-based models:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "defaults": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "model": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "primary": "anthropic/claude-sonnet-4-20250514",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "fallbacks": ["openai/gpt-4o-mini"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Don't try to run local LLMs on a Pi** — even small models are too slow. Let Claude/GPT do the heavy lifting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auto-Start on Boot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The onboarding wizard sets this up, but to verify:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check service is enabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo systemctl is-enabled openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Enable if not（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo systemctl enable openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Start on boot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo systemctl start openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Out of Memory (OOM)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
free -h（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Add more swap (see Step 5)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Or reduce services running on the Pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Slow Performance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use USB SSD instead of SD card（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Disable unused services: `sudo systemctl disable cups bluetooth avahi-daemon`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check CPU throttling: `vcgencmd get_throttled` (should return `0x0`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Service Won't Start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
journalctl -u openclaw --no-pager -n 100（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Common fix: rebuild（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd ~/openclaw  # if using hackable install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm run build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo systemctl restart openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### ARM Binary Issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a skill fails with "exec format error":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Check if the binary has an ARM64 build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Try building from source（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Or use a Docker container with ARM support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### WiFi Drops（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For headless Pis on WiFi:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Disable WiFi power management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo iwconfig wlan0 power off（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Make permanent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cost Comparison（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Setup          | One-Time Cost | Monthly Cost | Notes                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------- | ------------- | ------------ | ------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Pi 4 (2GB)** | ~$45          | $0           | + power (~$5/yr)          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Pi 4 (4GB)** | ~$55          | $0           | Recommended               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Pi 5 (4GB)** | ~$60          | $0           | Best performance          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Pi 5 (8GB)** | ~$80          | $0           | Overkill but future-proof |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| DigitalOcean   | $0            | $6/mo        | $72/year                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Hetzner        | $0            | €3.79/mo     | ~$50/year                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Break-even:** A Pi pays for itself in ~6-12 months vs cloud VPS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## See Also（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Linux guide](/platforms/linux) — general Linux setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [DigitalOcean guide](/platforms/digitalocean) — cloud alternative（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Hetzner guide](/install/hetzner) — Docker setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Tailscale](/gateway/tailscale) — remote access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Nodes](/nodes) — pair your laptop/phone with the Pi gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
