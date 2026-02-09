---
summary: "OpenClaw på Raspberry Pi (budgetvänlig självhostad setup)"
read_when:
  - Konfigurera OpenClaw på en Raspberry Pi
  - Köra OpenClaw på ARM-enheter
  - Bygga en billig, alltid-på personlig AI
title: "Raspberry Pi"
---

# OpenClaw på Raspberry Pi

## Mål

Kör en persistent, alltid-på OpenClaw Gateway på en Raspberry Pi för **~$35–80** i engångskostnad (inga månadsavgifter).

Perfekt för:

- Personlig AI-assistent dygnet runt
- Hemautomationshubb
- Lågströms, alltid-tillgänglig Telegram/WhatsApp-bot

## Hårdvarukrav

| Pi-modell       | RAM     | Fungerar?  | Noteringar                       |
| --------------- | ------- | ---------- | -------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ Bäst     | Snabbast, rekommenderas          |
| **Pi 4**        | 4GB     | ✅ Bra      | Bästa valet för de flesta        |
| **Pi 4**        | 2GB     | ✅ OK       | Fungerar, lägg till swap         |
| **Pi 4**        | 1GB     | ⚠️ Snålt   | Möjligt med swap, minimal konfig |
| **Pi 3B+**      | 1GB     | ⚠️ Långsam | Fungerar men seg                 |
| **Pi Zero 2 W** | 512MB   | ❌          | Rekommenderas inte               |

**Minimikrav:** 1GB RAM, 1 kärna, 500MB disk  
**Rekommenderat:** 2GB+ RAM, 64-bitars OS, 16GB+ SD-kort (eller USB-SSD)

## Vad du behöver

- Raspberry Pi 4 eller 5 (2GB+ rekommenderas)
- MicroSD-kort (16GB+) eller USB-SSD (bättre prestanda)
- Nätadapter (officiell Pi-PSU rekommenderas)
- Nätverksanslutning (Ethernet eller WiFi)
- ~30 minuter

## 1. Flasha OS

Använd **Raspberry Pi OS Lite (64-bit)** — inget skrivbord behövs för en headless-server.

1. Ladda ner [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Välj OS: **Raspberry Pi OS Lite (64-bit)**
3. Klicka på kugghjulsikonen (⚙️) för att förkonfigurera:
   - Ange värdnamn: `gateway-host`
   - Aktivera SSH
   - Ange användarnamn/lösenord
   - Konfigurera WiFi (om du inte använder Ethernet)
4. Flasha till ditt SD-kort/USB-minne
5. Sätt i och starta Pi

## 2) Anslut via SSH

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. Systemkonfiguration

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. Installera Node.js 22 (ARM64)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. Lägg till swap (Viktigt för 2GB eller mindre)

Swap förhindrar krascher på grund av minnesbrist:

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

## 6. Installera OpenClaw

### Alternativ A: Standardinstallation (Rekommenderas)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Alternativ B: Hackbar installation (För pill)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

Den hackbara installationen ger dig direkt åtkomst till loggar och kod — användbart för felsökning av ARM-specifika problem.

## 7. Kör introduktion

```bash
openclaw onboard --install-daemon
```

Följ guiden:

1. **Gateway-läge:** Lokalt
2. **Autentisering:** API-nycklar rekommenderas (OAuth kan vara krångligt på headless Pi)
3. **Kanaler:** Telegram är enklast att börja med
4. **Daemon:** Ja (systemd)

## 8) Verifiera installationen

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. Öppna instrumentpanelen

Eftersom Pi är headless, använd en SSH-tunnel:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

Eller använd Tailscale för alltid-på-åtkomst:

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## Prestandaoptimeringar

### Använd en USB-SSD (Stor förbättring)

SD-kort är långsamma och slitna. En USB-SSD förbättrar prestandan avsevärt:

```bash
# Check if booting from USB
lsblk
```

Se [Pi USB-bootguide](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) för konfigurering.

### Minska minnesanvändningen

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### Övervaka resurser

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## ARM-specifika noteringar

### Binär kompatibilitet

De flesta OpenClaw-funktioner fungerar på ARM64, men vissa externa binärer kan behöva ARM-byggen:

| Verktyg                                  | ARM64-status | Noteringar                          |
| ---------------------------------------- | ------------ | ----------------------------------- |
| Node.js                  | ✅            | Fungerar utmärkt                    |
| WhatsApp (Baileys)    | ✅            | Ren JS, inga problem                |
| Telegram                                 | ✅            | Ren JS, inga problem                |
| gog (Gmail CLI)       | ⚠️           | Kontrollera om ARM-version finns    |
| Chromium (webbläsare) | ✅            | `sudo apt install chromium-browser` |

Om en färdighet misslyckas, kontrollera om dess binär har en ARM-bygge. Många Go/Rust verktyg gör; vissa inte.

### 32-bit vs 64-bit

**Använd alltid 64-bitars OS.** Node.js och många moderna verktyg kräver det. Kontrollera med:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## Rekommenderad modellsetup

Eftersom Pi bara är Gateway (modeller körs i molnet), använd API-baserade modeller:

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

**Försök inte att köra lokala LLMs på en Pi** - även små modeller är för långsamma. Låt Claude/GPT göra den tunga lyft.

---

## Autostart vid uppstart

Introduktionsguiden konfigurerar detta, men för att verifiera:

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## Felsökning

### Slut på minne (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### Långsam prestanda

- Använd USB-SSD i stället för SD-kort
- Inaktivera oanvända tjänster: `sudo systemctl disable cups bluetooth avahi-daemon`
- Kontrollera CPU-strypning: `vcgencmd get_throttled` (bör returnera `0x0`)

### Tjänsten startar inte

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### ARM-binärproblem

Om en skill misslyckas med ”exec format error”:

1. Kontrollera om binären har ett ARM64-bygge
2. Försök bygga från källkod
3. Eller använd en Docker-container med ARM-stöd

### WiFi kopplar ner

För headless Pi på WiFi:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## Kostnadsjämförelse

| Setup                             | Engångskostnad       | Månadskostnad | Noteringar                                          |
| --------------------------------- | -------------------- | ------------- | --------------------------------------------------- |
| **Pi 4 (2GB)** | ~$45 | $0            | + ström (~$5/år) |
| **Pi 4 (4GB)** | ~$55 | $0            | Rekommenderas                                       |
| **Pi 5 (4GB)** | ~$60 | $0            | Bästa prestanda                                     |
| **Pi 5 (8GB)** | ~$80 | $0            | Overkill men framtidssäker                          |
| DigitalOcean                      | $0                   | $6/mån        | $72/år                                              |
| Hetzner                           | $0                   | €3,79/mån     | ~$50/år                             |

**Break-even:** En Pi betalar sig på ~6–12 månader jämfört med moln-VPS.

---

## Se även

- [Linux-guide](/platforms/linux) — generell Linux-setup
- [DigitalOcean-guide](/platforms/digitalocean) — molnalternativ
- [Hetzner-guide](/install/hetzner) — Docker-setup
- [Tailscale](/gateway/tailscale) — fjärråtkomst
- [Nodes](/nodes) — para ihop din laptop/telefon med Pi-gatewayen
