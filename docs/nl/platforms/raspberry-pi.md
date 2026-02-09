---
summary: "OpenClaw op Raspberry Pi (budget zelfgehoste setup)"
read_when:
  - OpenClaw instellen op een Raspberry Pi
  - OpenClaw draaien op ARM-apparaten
  - Een goedkope, altijd actieve persoonlijke AI bouwen
title: "Raspberry Pi"
---

# OpenClaw op Raspberry Pi

## Doel

Een persistente, altijd actieve OpenClaw Gateway draaien op een Raspberry Pi voor **~$35-80** eenmalige kosten (geen maandelijkse kosten).

Perfect voor:

- 24/7 persoonlijke AI-assistent
- Home-automatiseringshub
- Energiezuinige, altijd beschikbare Telegram/WhatsApp-bot

## Hardwarevereisten

| Pi-model        | RAM     | Werkt?      | Notities                               |
| --------------- | ------- | ----------- | -------------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ Best      | Snelst, aanbevolen                     |
| **Pi 4**        | 4GB     | ✅ Goed      | Beste balans voor de meeste gebruikers |
| **Pi 4**        | 2GB     | ✅ Oké       | Werkt, voeg swap toe                   |
| **Pi 4**        | 1GB     | ⚠️ Krap     | Mogelijk met swap, minimale config     |
| **Pi 3B+**      | 1GB     | ⚠️ Langzaam | Werkt, maar traag                      |
| **Pi Zero 2 W** | 512MB   | ❌           | Niet aanbevolen                        |

**Minimale specs:** 1GB RAM, 1 core, 500MB schijf  
**Aanbevolen:** 2GB+ RAM, 64-bits OS, 16GB+ SD-kaart (of USB-SSD)

## Wat je nodig hebt

- Raspberry Pi 4 of 5 (2GB+ aanbevolen)
- MicroSD-kaart (16GB+) of USB-SSD (betere prestaties)
- Voeding (officiële Pi-PSU aanbevolen)
- Netwerkverbinding (Ethernet of WiFi)
- ~30 minuten

## 1. Besturingssysteem flashen

Gebruik **Raspberry Pi OS Lite (64-bit)** — geen desktop nodig voor een headless server.

1. Download [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Kies OS: **Raspberry Pi OS Lite (64-bit)**
3. Klik op het tandwielpictogram (⚙️) om vooraf te configureren:
   - Hostnaam instellen: `gateway-host`
   - SSH inschakelen
   - Gebruikersnaam/wachtwoord instellen
   - WiFi configureren (als je geen Ethernet gebruikt)
4. Flash naar je SD-kaart / USB-schijf
5. Plaats de kaart en start de Pi

## 2) Verbinden via SSH

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. Systeeminstelling

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. Node.js 22 installeren (ARM64)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. Swap toevoegen (Belangrijk voor 2GB of minder)

Swap voorkomt out-of-memory-crashes:

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

## 6. OpenClaw installeren

### Optie A: Standaardinstallatie (Aanbevolen)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Optie B: Hackbare installatie (Voor experimenteren)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

De hackbare installatie geeft je directe toegang tot logs en code — handig voor het debuggen van ARM-specifieke problemen.

## 7. Onboarding uitvoeren

```bash
openclaw onboard --install-daemon
```

Volg de wizard:

1. **Gateway-modus:** Lokaal
2. **Auth:** API-sleutels aanbevolen (OAuth kan lastig zijn op een headless Pi)
3. **Kanalen:** Telegram is het makkelijkst om mee te beginnen
4. **Daemon:** Ja (systemd)

## 8) Installatie verifiëren

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. Toegang tot het dashboard

Omdat de Pi headless is, gebruik je een SSH-tunnel:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

Of gebruik Tailscale voor altijd actieve toegang:

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## Prestatie-optimalisaties

### Gebruik een USB-SSD (Grote verbetering)

SD-kaarten zijn traag en slijten snel. Een USB-SSD verbetert de prestaties drastisch:

```bash
# Check if booting from USB
lsblk
```

Zie de [Pi USB-bootgids](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) voor de installatie.

### Geheugengebruik verminderen

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### Resources monitoren

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## ARM-specifieke notities

### Binaire compatibiliteit

De meeste OpenClaw-functies werken op ARM64, maar sommige externe binaries hebben mogelijk ARM-builds nodig:

| Tool                                  | ARM64-status | Notities                            |
| ------------------------------------- | ------------ | ----------------------------------- |
| Node.js               | ✅            | Werkt uitstekend                    |
| WhatsApp (Baileys) | ✅            | Pure JS, geen problemen             |
| Telegram                              | ✅            | Pure JS, geen problemen             |
| gog (Gmail CLI)    | ⚠️           | Controleer of er een ARM-release is |
| Chromium (browser) | ✅            | `sudo apt install chromium-browser` |

Als een skill faalt, controleer dan of de binary een ARM-build heeft. Veel Go/Rust-tools hebben dat; sommige niet.

### 32-bit vs 64-bit

**Gebruik altijd een 64-bits OS.** Node.js en veel moderne tools vereisen dit. Controleer met:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## Aanbevolen modelsetup

Omdat de Pi alleen de Gateway is (modellen draaien in de cloud), gebruik je API-gebaseerde modellen:

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

**Probeer geen lokale LLM's op een Pi te draaien** — zelfs kleine modellen zijn te traag. Laat Claude/GPT het zware werk doen.

---

## Automatisch starten bij opstarten

De onboardingwizard stelt dit in, maar om te controleren:

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## Problemen oplossen

### Onvoldoende geheugen (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### Trage prestaties

- Gebruik een USB-SSD in plaats van een SD-kaart
- Schakel ongebruikte services uit: `sudo systemctl disable cups bluetooth avahi-daemon`
- Controleer CPU-throttling: `vcgencmd get_throttled` (moet `0x0` retourneren)

### Service start niet

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### ARM-binaire problemen

Als een skill faalt met "exec format error":

1. Controleer of de binary een ARM64-build heeft
2. Probeer vanaf de bron te bouwen
3. Of gebruik een Docker-container met ARM-ondersteuning

### WiFi valt weg

Voor headless Pi's op WiFi:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## Kostenvergelijking

| Setup                             | Eenmalige kosten     | Maandelijkse kosten         | Notities                                               |
| --------------------------------- | -------------------- | --------------------------- | ------------------------------------------------------ |
| **Pi 4 (2GB)** | ~$45 | $0                          | + stroom (~$5/jaar) |
| **Pi 4 (4GB)** | ~$55 | $0                          | Aanbevolen                                             |
| **Pi 5 (4GB)** | ~$60 | $0                          | Beste prestaties                                       |
| **Pi 5 (8GB)** | ~$80 | $0                          | Overkill maar toekomstbestendig                        |
| DigitalOcean                      | $0                   | $6/maand                    | $72/jaar                                               |
| Hetzner                           | $0                   | €3.79/maand | ~$50/jaar                              |

**Omslagpunt:** Een Pi verdient zichzelf terug in ~6-12 maanden vergeleken met een cloud-VPS.

---

## Zie ook

- [Linux-gids](/platforms/linux) — algemene Linux-installatie
- [DigitalOcean-gids](/platforms/digitalocean) — cloudalternatief
- [Hetzner-gids](/install/hetzner) — Docker-installatie
- [Tailscale](/gateway/tailscale) — toegang op afstand
- [Nodes](/nodes) — koppel je laptop/telefoon aan de Pi Gateway
