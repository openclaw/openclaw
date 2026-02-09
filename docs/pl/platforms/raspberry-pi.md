---
summary: "OpenClaw na Raspberry Pi (budżetowa konfiguracja self-hosted)"
read_when:
  - Konfiguracja OpenClaw na Raspberry Pi
  - Uruchamianie OpenClaw na urządzeniach ARM
  - Budowa taniej, zawsze włączonej osobistej AI
title: "Raspberry Pi"
---

# OpenClaw na Raspberry Pi

## Cel

Uruchomienie trwałego, zawsze włączonego Gateway OpenClaw na Raspberry Pi przy **jednorazowym koszcie ~35–80 USD** (bez opłat miesięcznych).

Idealne dla:

- osobistego asystenta AI działającego 24/7
- huba automatyki domowej
- niskoprądowego, zawsze dostępnego bota Telegram/WhatsApp

## Wymagania sprzętowe

| Model Pi        | RAM     | Działa?     | Uwagi                                       |
| --------------- | ------- | ----------- | ------------------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ Najlepsze | Najszybszy, zalecany                        |
| **Pi 4**        | 4GB     | ✅ Dobre     | Słodkie miejsce dla większości użytkowników |
| **Pi 4**        | 2GB     | ✅ OK        | Działa, dodaj swap                          |
| **Pi 4**        | 1GB     | ⚠️ Jasny    | Możliwe z swap, minimalna konfiguracja      |
| **Pi 3B+**      | 1GB     | ⚠️ Wolny    | Działa, ale ociężałe                        |
| **Pi Zero 2 W** | 512MB   | ❌           | Niezalecane                                 |

**Minimalne parametry:** 1GB RAM, 1 rdzeń, 500MB dysku  
**Zalecane:** 2GB+ RAM, system 64-bit, karta SD 16GB+ (lub USB SSD)

## Czego potrzebujesz

- Raspberry Pi 4 lub 5 (zalecane 2GB+)
- Karta MicroSD (16GB+) lub USB SSD (lepsza wydajność)
- Zasilacz (zalecany oficjalny zasilacz Pi)
- Połączenie sieciowe (Ethernet lub WiFi)
- ~30 minut

## 1. Wgraj system operacyjny

Użyj **Raspberry Pi OS Lite (64-bit)** — bez środowiska graficznego dla serwera headless.

1. Pobierz [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Wybierz OS: **Raspberry Pi OS Lite (64-bit)**
3. Kliknij ikonę koła zębatego (⚙️), aby wstępnie skonfigurować:
   - Ustaw nazwę hosta: `gateway-host`
   - Włącz SSH
   - Ustaw nazwę użytkownika/hasło
   - Skonfiguruj WiFi (jeśli nie używasz Ethernetu)
4. Wgraj obraz na kartę SD / dysk USB
5. Włóż nośnik i uruchom Pi

## 2) Połącz się przez SSH

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. Konfiguracja systemu

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. Zainstaluj Node.js 22 (ARM64)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. Dodaj swap (ważne dla 2GB lub mniej)

Swap zapobiega awariom z powodu braku pamięci:

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

## 6. Zainstaluj OpenClaw

### Opcja A: Instalacja standardowa (zalecana)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Opcja B: Instalacja „hackowalna” (do eksperymentów)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

Instalacja „hackowalna” zapewnia bezpośredni dostęp do logów i kodu — przydatne przy debugowaniu problemów specyficznych dla ARM.

## 7. Uruchom onboarding

```bash
openclaw onboard --install-daemon
```

Postępuj zgodnie z kreatorem:

1. **Tryb Gateway:** Lokalne
2. **Uwierzytelnianie:** Zalecane klucze API (OAuth bywa kapryśny na headless Pi)
3. **Kanały:** Telegram jest najłatwiejszy na start
4. **Demon:** Tak (systemd)

## 8) Zweryfikuj instalację

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. Dostęp do panelu

Ponieważ Pi działa w trybie headless, użyj tunelu SSH:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

Albo użyj Tailscale do stałego dostępu:

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## Optymalizacje wydajności

### Użyj USB SSD (ogromna poprawa)

Karty SD są wolne i zużywają się. USB SSD znacząco poprawia wydajność:

```bash
# Check if booting from USB
lsblk
```

Zobacz [przewodnik uruchamiania Pi z USB](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) w celu konfiguracji.

### Zmniejsz zużycie pamięci

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### Monitoruj zasoby

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## Uwagi specyficzne dla ARM

### Zgodność binarna

Większość funkcji OpenClaw działa na ARM64, ale niektóre zewnętrzne binaria mogą wymagać wersji ARM:

| Narzędzie                                  | Status ARM64 | Uwagi                               |
| ------------------------------------------ | ------------ | ----------------------------------- |
| Node.js                    | ✅            | Działa świetnie                     |
| WhatsApp (Baileys)      | ✅            | Czysty JS, bez problemów            |
| Telegram                                   | ✅            | Czysty JS, bez problemów            |
| gog (Gmail CLI)         | ⚠️           | Sprawdź dostępność wersji ARM       |
| Chromium (przeglądarka) | ✅            | `sudo apt install chromium-browser` |

Jeśli Skill nie działa, sprawdź, czy jego binarium ma wersję ARM. Wiele narzędzi Go/Rust ją ma; niektóre nie.

### 32-bit vs 64-bit

**Zawsze używaj systemu 64-bitowego.** Node.js i wiele nowoczesnych narzędzi tego wymaga. Sprawdź poleceniem:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## Zalecana konfiguracja modeli

Ponieważ Pi pełni wyłącznie rolę Gateway (modele działają w chmurze), używaj modeli opartych na API:

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

**Nie próbuj uruchamiać lokalnych LLM-ów na Pi** — nawet małe modele są zbyt wolne. Pozwól Claude/GPT wykonać ciężką pracę.

---

## Automatyczny start przy uruchomieniu

Kreator onboardingu konfiguruje to automatycznie, ale aby zweryfikować:

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## Rozwiązywanie problemów

### Brak pamięci (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### Niska wydajność

- Użyj USB SSD zamiast karty SD
- Wyłącz nieużywane usługi: `sudo systemctl disable cups bluetooth avahi-daemon`
- Sprawdź dławienie CPU: `vcgencmd get_throttled` (powinno zwrócić `0x0`)

### Usługa nie chce się uruchomić

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### Problemy z binariami ARM

Jeśli Skill kończy się błędem „exec format error”:

1. Sprawdź, czy binarium ma wersję ARM64
2. Spróbuj zbudować ze źródeł
3. Albo użyj kontenera Docker z obsługą ARM

### Zrywanie WiFi

Dla headless Pi na WiFi:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## Porównanie kosztów

| Konfiguracja                      | Koszt jednorazowy    | Koszt miesięczny            | Uwagi                                               |
| --------------------------------- | -------------------- | --------------------------- | --------------------------------------------------- |
| **Pi 4 (2GB)** | ~$45 | $0                          | + prąd (~$5/rok) |
| **Pi 4 (4GB)** | ~$55 | $0                          | Zalecane                                            |
| **Pi 5 (4GB)** | ~$60 | $0                          | Najlepsza wydajność                                 |
| **Pi 5 (8GB)** | ~$80 | $0                          | Przesada, ale przyszłościowe                        |
| DigitalOcean                      | $0                   | $6/mies.    | $72/rok                                             |
| Hetzner                           | $0                   | €3,79/mies. | ~$50/rok                            |

**Punkt równowagi:** Pi zwraca się po ~6–12 miesiącach w porównaniu z chmurowym VPS.

---

## Zobacz także

- [Przewodnik Linux](/platforms/linux) — ogólna konfiguracja Linux
- [Przewodnik DigitalOcean](/platforms/digitalocean) — alternatywa chmurowa
- [Przewodnik Hetzner](/install/hetzner) — konfiguracja Docker
- [Tailscale](/gateway/tailscale) — zdalny dostęp
- [Węzły](/nodes) — sparuj laptop/telefon z bramą Pi
