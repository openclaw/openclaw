---
summary: "OpenClaw på Raspberry Pi (budgetvenlig selvhostet opsætning)"
read_when:
  - Opsætning af OpenClaw på en Raspberry Pi
  - Kørsel af OpenClaw på ARM-enheder
  - Opbygning af en billig, altid-tilgængelig personlig AI
title: "Raspberry Pi"
---

# OpenClaw på Raspberry Pi

## Mål

Kør en persistent, altid-tændt OpenClaw Gateway på en Raspberry Pi for **~$35-80** i engangsomkostning (ingen månedlige gebyrer).

Perfekt til:

- Personlig AI-assistent 24/7
- Hub til hjemmeautomatisering
- Strømbesparende, altid-tilgængelig Telegram/WhatsApp-bot

## Hardwarekrav

| Pi-model        | RAM     | Virker?    | Noter                            |
| --------------- | ------- | ---------- | -------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ Bedst    | Hurtigst, anbefalet              |
| **Pi 4**        | 4GB     | ✅ God      | Sweet spot for de fleste brugere |
| **Pi 4**        | 2GB     | ✅ OK       | Virker, tilføj swap              |
| **Pi 4**        | 1GB     | ⚠️ Stramt  | Muligt med swap, minimal konfig  |
| **Pi 3B+**      | 1GB     | ⚠️ Langsom | Virker men er sløv               |
| **Pi Zero 2 W** | 512MB   | ❌          | Ikke anbefalet                   |

**Minimumsspecifikationer:** 1GB RAM, 1 kerne, 500MB disk  
**Anbefalet:** 2GB+ RAM, 64-bit OS, 16GB+ SD-kort (eller USB SSD)

## Det skal du bruge

- Raspberry Pi 4 eller 5 (2GB+ anbefalet)
- MicroSD-kort (16GB+) eller USB SSD (bedre ydeevne)
- Strømforsyning (officiel Pi-PSU anbefalet)
- Netværksforbindelse (Ethernet eller WiFi)
- ~30 minutter

## 1. Flash OS

Brug **Raspberry Pi OS Lite (64-bit)** — ingen desktop nødvendig til en headless server.

1. Download [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Vælg OS: **Raspberry Pi OS Lite (64-bit)**
3. Klik på tandhjulsikonet (⚙️) for at forudkonfigurere:
   - Sæt hostname: `gateway-host`
   - Aktivér SSH
   - Sæt brugernavn/adgangskode
   - Konfigurér WiFi (hvis du ikke bruger Ethernet)
4. Flash til dit SD-kort / USB-drev
5. Indsæt og boot Pi’en

## 2) Forbind via SSH

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. Systemopsætning

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. Installér Node.js 22 (ARM64)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. Tilføj swap (vigtigt for 2GB eller mindre)

Swap forhindrer out-of-memory-crash:

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

## 6. Installér OpenClaw

### Mulighed A: Standardinstallation (anbefalet)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Mulighed B: Hackbar installation (til tinkering)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

Den hackbare installation giver dig direkte adgang til logs og kode — nyttigt til fejlfinding af ARM-specifikke problemer.

## 7. Kør introduktion

```bash
openclaw onboard --install-daemon
```

Følg opsætningsguiden:

1. **Gateway-tilstand:** Lokal
2. **Auth:** API-nøgler anbefales (OAuth kan være ustabil på headless Pi)
3. **Kanaler:** Telegram er lettest at starte med
4. **Daemon:** Ja (systemd)

## 8) Bekræft installation

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. Få adgang til dashboardet

Da Pi’en er headless, brug en SSH-tunnel:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

Eller brug Tailscale for altid-tilgængelig adgang:

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## Ydeevneoptimeringer

### Brug en USB SSD (stor forbedring)

SD-kort er langsomme og slid ud. En USB-SSD forbedrer ydeevnen dramatisk:

```bash
# Check if booting from USB
lsblk
```

Se [Pi USB boot guide](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) for opsætning.

### Reducér hukommelsesforbrug

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### Overvåg ressourcer

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## ARM-specifikke noter

### Binær kompatibilitet

De fleste OpenClaw-funktioner virker på ARM64, men nogle eksterne binærer kan kræve ARM-builds:

| Værktøj                               | ARM64-status | Noter                               |
| ------------------------------------- | ------------ | ----------------------------------- |
| Node.js               | ✅            | Virker rigtig godt                  |
| WhatsApp (Baileys) | ✅            | Ren JS, ingen problemer             |
| Telegram                              | ✅            | Ren JS, ingen problemer             |
| gog (Gmail CLI)    | ⚠️           | Tjek for ARM-udgivelse              |
| Chromium (browser) | ✅            | `sudo apt install chromium-browser` |

Hvis en færdighed mislykkes, tjek om dens binære har en ARM bygning. Mange Go/Rust værktøjer gør; nogle ikke.

### 32-bit vs 64-bit

\*\*Brug altid 64-bit OS \*\* Node.js og mange moderne værktøjer kræver det. Kontroller med:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## Anbefalet modelopsætning

Da Pi’en kun er Gateway (modeller kører i skyen), brug API-baserede modeller:

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

**Forsøg ikke at køre lokale LLM på en Pi** - selv små modeller er for langsomme. Lad Claude/GPT gøre den tunge løft.

---

## Automatisk start ved boot

Introduktionsguiden sætter dette op, men for at bekræfte:

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## Fejlfinding

### Out of Memory (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### Langsom ydeevne

- Brug USB SSD i stedet for SD-kort
- Deaktivér ubrugte tjenester: `sudo systemctl disable cups bluetooth avahi-daemon`
- Tjek CPU-throttling: `vcgencmd get_throttled` (bør returnere `0x0`)

### Tjenesten starter ikke

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### ARM-binærproblemer

Hvis en skill fejler med “exec format error”:

1. Tjek om binæren har et ARM64-build
2. Prøv at bygge fra kildekode
3. Eller brug en Docker-container med ARM-understøttelse

### WiFi-afbrydelser

For headless Pi’er på WiFi:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## Sammenligning af omkostninger

| Opsætning                         | Engangsomkostning    | Månedlig omkostning | Noter                                               |
| --------------------------------- | -------------------- | ------------------- | --------------------------------------------------- |
| **Pi 4 (2GB)** | ~$45 | $0                  | + strøm (~$5/år) |
| **Pi 4 (4GB)** | ~$55 | $0                  | Anbefalet                                           |
| **Pi 5 (4GB)** | ~$60 | $0                  | Bedste ydeevne                                      |
| **Pi 5 (8GB)** | ~$80 | $0                  | Overkill men fremtidssikret                         |
| DigitalOcean                      | $0                   | $6/md               | $72/år                                              |
| Hetzner                           | $0                   | €3,79/md            | ~$50/år                             |

**Break-even:** En Pi tjener sig selv hjem på ~6-12 måneder sammenlignet med cloud VPS.

---

## Se også

- [Linux guide](/platforms/linux) — generel Linux-opsætning
- [DigitalOcean guide](/platforms/digitalocean) — cloud-alternativ
- [Hetzner guide](/install/hetzner) — Docker-opsætning
- [Tailscale](/gateway/tailscale) — fjernadgang
- [Nodes](/nodes) — par din laptop/telefon med Pi-gatewayen
