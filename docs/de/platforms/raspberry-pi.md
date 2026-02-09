---
summary: "„OpenClaw auf Raspberry Pi (günstiges selbstgehostetes Setup)“"
read_when:
  - OpenClaw auf einem Raspberry Pi einrichten
  - OpenClaw auf ARM-Geräten betreiben
  - Eine günstige, dauerhaft aktive persönliche KI bauen
title: "„Raspberry Pi“"
---

# OpenClaw auf Raspberry Pi

## Ziel

Einen persistenten, dauerhaft aktiven OpenClaw Gateway auf einem Raspberry Pi mit **~35–80 $** einmaligen Kosten betreiben (keine monatlichen Gebühren).

Perfekt für:

- Persönlichen KI-Assistenten rund um die Uhr
- Home-Automation-Hub
- Stromsparenden, jederzeit verfügbaren Telegram-/WhatsApp-Bot

## Hardwareanforderungen

| Pi-Modell       | RAM     | Läuft?     | Hinweise                          |
| --------------- | ------- | ---------- | --------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ Best     | Am schnellsten, empfohlen         |
| **Pi 4**        | 4GB     | ✅ Gut      | Sweet Spot für die meisten Nutzer |
| **Pi 4**        | 2GB     | ✅ OK       | Läuft, Swap hinzufügen            |
| **Pi 4**        | 1GB     | ⚠️ Knapp   | Mit Swap möglich, Minimal-Config  |
| **Pi 3B+**      | 1GB     | ⚠️ Langsam | Läuft, aber träge                 |
| **Pi Zero 2 W** | 512MB   | ❌          | Nicht empfohlen                   |

**Mindestanforderungen:** 1GB RAM, 1 Core, 500MB Speicher  
**Empfohlen:** 2GB+ RAM, 64-Bit-OS, 16GB+ SD-Karte (oder USB-SSD)

## Was Sie benötigen

- Raspberry Pi 4 oder 5 (2GB+ empfohlen)
- MicroSD-Karte (16GB+) oder USB-SSD (bessere Performance)
- Netzteil (offizielles Pi-Netzteil empfohlen)
- Netzwerkverbindung (Ethernet oder WLAN)
- ~30 Minuten

## 1. OS flashen

Verwenden Sie **Raspberry Pi OS Lite (64-bit)** — kein Desktop für einen Headless-Server nötig.

1. Laden Sie den [Raspberry Pi Imager](https://www.raspberrypi.com/software/) herunter
2. Wählen Sie OS: **Raspberry Pi OS Lite (64-bit)**
3. Klicken Sie auf das Zahnrad-Symbol (⚙️) zur Vorkonfiguration:
   - Hostname festlegen: `gateway-host`
   - SSH aktivieren
   - Benutzername/Passwort setzen
   - WLAN konfigurieren (falls kein Ethernet genutzt wird)
4. Auf Ihre SD-Karte / Ihr USB-Laufwerk flashen
5. Pi einsetzen und starten

## 2) Per SSH verbinden

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. System einrichten

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. Node.js 22 installieren (ARM64)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. Swap hinzufügen (wichtig bei 2GB oder weniger)

Swap verhindert Out-of-Memory-Abstürze:

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

## 6. OpenClaw installieren

### Option A: Standardinstallation (empfohlen)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Option B: Hackbare Installation (zum Basteln)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

Die hackbare Installation gibt Ihnen direkten Zugriff auf Logs und Code — nützlich für das Debugging ARM-spezifischer Probleme.

## 7. Onboarding ausführen

```bash
openclaw onboard --install-daemon
```

Folgen Sie dem Assistenten:

1. **Gateway-Modus:** Lokal
2. **Auth:** API-Schlüssel empfohlen (OAuth kann auf einem Headless-Pi heikel sein)
3. **Kanäle:** Telegram ist am einfachsten für den Einstieg
4. **Daemon:** Ja (systemd)

## 8) Installation überprüfen

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. Zugriff auf das Dashboard

Da der Pi headless ist, verwenden Sie einen SSH-Tunnel:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

Oder nutzen Sie Tailscale für dauerhaften Zugriff:

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## Performance-Optimierungen

### USB-SSD verwenden (großer Gewinn)

SD-Karten sind langsam und verschleißen. Eine USB-SSD verbessert die Performance deutlich:

```bash
# Check if booting from USB
lsblk
```

Siehe [Pi USB-Boot-Anleitung](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) für die Einrichtung.

### Speicherverbrauch reduzieren

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### Ressourcen überwachen

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## ARM-spezifische Hinweise

### Binärkompatibilität

Die meisten OpenClaw-Funktionen laufen auf ARM64, aber einige externe Binaries benötigen ARM-Builds:

| Werkzeug                              | ARM64-Status | Hinweise                            |
| ------------------------------------- | ------------ | ----------------------------------- |
| Node.js               | ✅            | Läuft hervorragend                  |
| WhatsApp (Baileys) | ✅            | Reines JS, keine Probleme           |
| Telegram                              | ✅            | Reines JS, keine Probleme           |
| gog (Gmail CLI)    | ⚠️           | Auf ARM-Release prüfen              |
| Chromium (Browser) | ✅            | `sudo apt install chromium-browser` |

Wenn ein Skill fehlschlägt, prüfen Sie, ob dessen Binary einen ARM-Build hat. Viele Go-/Rust-Tools haben einen; manche nicht.

### 32-Bit vs. 64-Bit

**Verwenden Sie immer ein 64-Bit-OS.** Node.js und viele moderne Tools erfordern dies. Prüfen Sie mit:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## Empfohlenes Modell-Setup

Da der Pi nur das Gateway ist (Modelle laufen in der Cloud), verwenden Sie API-basierte Modelle:

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

**Versuchen Sie nicht, lokale LLMs auf einem Pi auszuführen** — selbst kleine Modelle sind zu langsam. Lassen Sie Claude/GPT die schwere Arbeit erledigen.

---

## Autostart beim Booten

Der Onboarding-Assistent richtet dies ein; zur Überprüfung:

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## Fehlerbehebung

### Out of Memory (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### Langsame Performance

- USB-SSD statt SD-Karte verwenden
- Ungenutzte Dienste deaktivieren: `sudo systemctl disable cups bluetooth avahi-daemon`
- CPU-Drosselung prüfen: `vcgencmd get_throttled` (sollte `0x0` zurückgeben)

### Dienst startet nicht

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### ARM-Binary-Probleme

Wenn ein Skill mit „exec format error“ fehlschlägt:

1. Prüfen Sie, ob das Binary einen ARM64-Build hat
2. Versuchen Sie, aus dem Quellcode zu bauen
3. Oder verwenden Sie einen Docker-Container mit ARM-Unterstützung

### WLAN-Abbrüche

Für Headless-Pis im WLAN:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## Kostenvergleich

| Setup                             | Einmalige Kosten     | Monatliche Kosten | Hinweise                                              |
| --------------------------------- | -------------------- | ----------------- | ----------------------------------------------------- |
| **Pi 4 (2GB)** | ~$45 | $0                | + Strom (~$5/Jahr) |
| **Pi 4 (4GB)** | ~$55 | $0                | Empfohlen                                             |
| **Pi 5 (4GB)** | ~$60 | $0                | Beste Performance                                     |
| **Pi 5 (8GB)** | ~$80 | $0                | Overkill, aber zukunftssicher                         |
| DigitalOcean                      | $0                   | $6/Monat          | $72/Jahr                                              |
| Hetzner                           | $0                   | €3,79/Monat       | ~$50/Jahr                             |

**Break-even:** Ein Pi amortisiert sich nach ~6–12 Monaten gegenüber einer Cloud-VPS.

---

## Siehe auch

- [Linux-Anleitung](/platforms/linux) — allgemeines Linux-Setup
- [DigitalOcean-Anleitung](/platforms/digitalocean) — Cloud-Alternative
- [Hetzner-Anleitung](/install/hetzner) — Docker-Setup
- [Tailscale](/gateway/tailscale) — Remote-Zugriff
- [Nodes](/nodes) — Koppeln Sie Laptop/Telefon mit dem Pi-Gateway
