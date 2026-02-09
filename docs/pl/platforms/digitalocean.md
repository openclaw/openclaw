---
summary: "„OpenClaw na DigitalOcean (prosta płatna opcja VPS)”"
read_when:
  - Konfigurowanie OpenClaw na DigitalOcean
  - Szukanie taniego hostingu VPS dla OpenClaw
title: "DigitalOcean"
---

# OpenClaw na DigitalOcean

## Cel

Uruchomienie trwałego Gateway OpenClaw na DigitalOcean za **6 USD/mies.** (lub 4 USD/mies. przy cenach rezerwowanych).

Jeśli chcesz opcję za 0 USD/mies. i nie przeszkadza Ci ARM oraz konfiguracja specyficzna dla dostawcy, zobacz [przewodnik Oracle Cloud](/platforms/oracle).

## Porównanie kosztów (2026)

| Dostawca     | Plan            | Specyfikacja         | Cena/m2                                            | Uwagi                                             |
| ------------ | --------------- | -------------------- | -------------------------------------------------- | ------------------------------------------------- |
| Oracle Cloud | Always Free ARM | do 4 OCPU, 24 GB RAM | 0 USD                                              | ARM, ograniczona dostępność / niuanse rejestracji |
| Hetzner      | CX22            | 2 vCPU, 4 GB RAM     | 3,79 € (~4 USD) | Najtańsza płatna opcja                            |
| DigitalOcean | Basic           | 1 vCPU, 1 GB RAM     | 6 USD                                              | Prosty interfejs, dobra dokumentacja              |
| Vultr        | Cloud Compute   | 1 vCPU, 1 GB RAM     | 6 USD                                              | Wiele lokalizacji                                 |
| Linode       | Nanode          | 1 vCPU, 1 GB RAM     | 5 USD                                              | Obecnie część Akamai                              |

**Wybór dostawcy:**

- DigitalOcean: najprostszy UX + przewidywalna konfiguracja (ten przewodnik)
- Hetzner: dobry stosunek ceny do wydajności (zobacz [przewodnik Hetzner](/install/hetzner))
- Oracle Cloud: może kosztować 0 USD/mies., ale jest bardziej kapryśny i tylko ARM (zobacz [przewodnik Oracle](/platforms/oracle))

---

## Wymagania wstępne

- Konto DigitalOcean ([rejestracja z 200 USD darmowego kredytu](https://m.do.co/c/signup))
- Para kluczy SSH (lub gotowość do użycia uwierzytelniania hasłem)
- ~20 minut

## 1. Utwórz Droplet

1. Zaloguj się do [DigitalOcean](https://cloud.digitalocean.com/)
2. Kliknij **Create → Droplets**
3. Wybierz:
   - **Region:** Najbliższy Tobie (lub Twoim użytkownikom)
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **6 USD/mies.** (1 vCPU, 1 GB RAM, 25 GB SSD)
   - **Authentication:** Klucz SSH (zalecane) lub hasło
4. Kliknij **Create Droplet**
5. Zanotuj adres IP

## 2) Połącz się przez SSH

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. Zainstaluj OpenClaw

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4. Uruchom onboarding

```bash
openclaw onboard --install-daemon
```

Kreator przejdzie przez Ciebie:

- Uwierzytelnianie modelu (klucze API lub OAuth)
- Konfigurację kanałów (Telegram, WhatsApp, Discord itd.)
- Token Gateway (generowany automatycznie)
- Instalację demona (systemd)

## 5. Zweryfikuj Gateway

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. Uzyskaj dostęp do panelu

Gateway domyślnie wiąże się z local loopback. Aby uzyskać dostęp do Control UI:

**Opcja A: tunel SSH (zalecane)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**Opcja B: Tailscale Serve (HTTPS, tylko loopback)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Otwórz: `https://<magicdns>/`

Uwagi:

- Serve utrzymuje Gateway wyłącznie na local loopback i uwierzytelnia przez nagłówki tożsamości Tailscale.
- Aby zamiast tego wymagać tokenu/hasła, ustaw `gateway.auth.allowTailscale: false` lub użyj `gateway.auth.mode: "password"`.

**Opcja C: powiązanie z tailnet (bez Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Otwórz: `http://<tailscale-ip>:18789` (wymagany token).

## 7. Podłącz swoje kanały

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

Zobacz [Kanały](/channels) dla innych dostawców.

---

## Optymalizacje dla 1 GB RAM

Droplet za 6 USD ma tylko 1 GB RAM. Aby utrzymać płynne działanie:

### Dodaj swap (zalecane)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Użyj lżejszego modelu

Jeśli trafiasz na OOM, rozważ:

- Używanie modeli opartych o API (Claude, GPT) zamiast modeli lokalnych
- Ustawienie `agents.defaults.model.primary` na mniejszy model

### Monitoruj pamięć

```bash
free -h
htop
```

---

## Trwałość

Cały stan znajduje się w:

- `~/.openclaw/` — konfiguracja, poświadczenia, dane sesji
- `~/.openclaw/workspace/` — obszar roboczy (SOUL.md, pamięć itd.)

Dane te przetrwają restarty. Wykonuj okresowe kopie zapasowe:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Darmowa alternatywa Oracle Cloud

Oracle Cloud oferuje instancje ARM **Always Free**, które są znacząco mocniejsze niż jakakolwiek płatna opcja tutaj — za 0 USD/mies.

| Co otrzymujesz     | Specyfikacja                   |
| ------------------ | ------------------------------ |
| **4 OCPU**         | ARM Ampere A1                  |
| **24 GB RAM**      | Więcej niż wystarczająco       |
| **200 GB storage** | Wolumen blokowy                |
| **Zawsze darmowe** | Brak obciążeń karty kredytowej |

**Zastrzeżenia:**

- Rejestracja bywa kapryśna (spróbuj ponownie, jeśli się nie powiedzie)
- Architektura ARM — większość rzeczy działa, ale niektóre binaria wymagają wersji ARM

Pełny przewodnik konfiguracji znajdziesz w [Oracle Cloud](/platforms/oracle). Wskazówki dotyczące rejestracji i rozwiązywania problemów z procesem zapisów znajdziesz w tym [przewodniku społeczności](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## Rozwiązywanie problemów

### Gateway nie uruchamia się

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### Port jest już używany

```bash
lsof -i :18789
kill <PID>
```

### Brak pamięci

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## Zobacz także

- [Przewodnik Hetzner](/install/hetzner) — tańszy, bardziej wydajny
- [Instalacja Docker](/install/docker) — konfiguracja konteneryzowana
- [Tailscale](/gateway/tailscale) — bezpieczny dostęp zdalny
- [Konfiguracja](/gateway/configuration) — pełne referencje konfiguracji
